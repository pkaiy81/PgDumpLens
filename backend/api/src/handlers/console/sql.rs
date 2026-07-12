//! SQL execution against a persistent console connection.
//!
//! Mirrors the classification logic in [`crate::handlers::query`] but targets an
//! already-open, already-configured [`PgConnection`] (no connect / no timeout
//! setup here) and returns structured [`Block`]s instead of a single response.

use serde_json::Value;
use sqlx::{Column, Executor, Row};

use super::session::MAX_ROWS;
use super::Block;
use crate::handlers::query::first_keyword;

/// Execute one complete SQL statement and render it as console blocks.
///
/// SQL errors are returned as an `error` block (never an `Err`) so the session
/// stays alive, matching psql's behaviour.
pub async fn run_sql(conn: &mut sqlx::postgres::PgConnection, sql: &str) -> Vec<Block> {
    let sql = sql.trim().trim_end_matches(';').trim();
    if sql.is_empty() {
        return vec![Block::Error {
            text: "ERROR:  empty query".to_string(),
        }];
    }

    // Classify the statement via its describe metadata.
    let describe = match (&mut *conn).describe(sql).await {
        Ok(d) => d,
        Err(e) => {
            return vec![Block::Error {
                text: format_pg_error(&e),
            }]
        }
    };
    let described_columns: Vec<String> = describe
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();

    let keyword = first_keyword(sql);
    // EXPLAIN / SHOW cannot be wrapped in a CTE; fetch as plain text rows.
    let is_text = matches!(keyword.as_str(), "EXPLAIN" | "SHOW");

    if !is_text && described_columns.is_empty() {
        // Command path: DDL / DML without a result set.
        match sqlx::query(sql).execute(&mut *conn).await {
            Ok(res) => vec![Block::Text {
                text: command_tag(sql, res.rows_affected()),
            }],
            Err(e) => vec![Block::Error {
                text: format_pg_error(&e),
            }],
        }
    } else if is_text {
        // Text path: EXPLAIN / SHOW. Stringify every column.
        match sqlx::query(sql).fetch_all(&mut *conn).await {
            Ok(raw_rows) => {
                let columns: Vec<String> = if !described_columns.is_empty() {
                    described_columns
                } else if let Some(first) = raw_rows.first() {
                    first
                        .columns()
                        .iter()
                        .map(|c| c.name().to_string())
                        .collect()
                } else {
                    Vec::new()
                };
                let rows: Vec<Vec<Option<String>>> = raw_rows
                    .iter()
                    .map(|row| {
                        (0..columns.len())
                            .map(|i| row.try_get::<Option<String>, _>(i).ok().flatten())
                            .collect()
                    })
                    .collect();
                let footer = Some(rows_footer(rows.len()));
                vec![Block::Table {
                    columns,
                    rows,
                    footer,
                    expanded: false,
                }]
            }
            Err(e) => vec![Block::Error {
                text: format_pg_error(&e),
            }],
        }
    } else {
        // Rows path: SELECT / WITH / VALUES / DML with RETURNING. Wrap so a
        // uniform jsonb projection and a LIMIT can be applied.
        let wrapped = format!(
            "WITH q AS ({}) SELECT to_jsonb(q.*) AS row_data FROM q LIMIT {}",
            sql,
            MAX_ROWS + 1
        );
        match sqlx::query(&wrapped).fetch_all(&mut *conn).await {
            Ok(raw) => {
                let mut json_rows: Vec<Value> =
                    raw.iter().map(|r| r.get::<Value, _>("row_data")).collect();
                let truncated = json_rows.len() as i64 > MAX_ROWS;
                if truncated {
                    json_rows.truncate(MAX_ROWS as usize);
                }
                let columns = described_columns;
                let rows: Vec<Vec<Option<String>>> = json_rows
                    .iter()
                    .map(|v| {
                        columns
                            .iter()
                            .map(|col| v.get(col).and_then(json_value_to_cell))
                            .collect()
                    })
                    .collect();
                let footer = Some(if truncated {
                    format!("({} rows, output truncated)", rows.len())
                } else {
                    rows_footer(rows.len())
                });
                vec![Block::Table {
                    columns,
                    rows,
                    footer,
                    expanded: false,
                }]
            }
            Err(e) => vec![Block::Error {
                text: format_pg_error(&e),
            }],
        }
    }
}

/// psql-style row-count footer.
fn rows_footer(n: usize) -> String {
    if n == 1 {
        "(1 row)".to_string()
    } else {
        format!("({} rows)", n)
    }
}

/// Build a psql-style command tag for a statement without a result set.
pub fn command_tag(sql: &str, n: u64) -> String {
    let kw = first_keyword(sql);
    match kw.as_str() {
        "INSERT" => format!("INSERT 0 {}", n),
        "UPDATE" | "DELETE" => format!("{} {}", kw, n),
        "BEGIN" | "COMMIT" | "ROLLBACK" | "SET" | "RESET" | "SAVEPOINT" => kw,
        "TRUNCATE" => "TRUNCATE TABLE".to_string(),
        "CREATE" | "ALTER" | "DROP" => two_word_upper(sql),
        _ => kw,
    }
}

/// First two comment-aware keywords, uppercased (e.g. `CREATE TABLE`).
fn two_word_upper(sql: &str) -> String {
    let kw1 = first_keyword(sql);
    if kw1.is_empty() {
        return String::new();
    }
    let upper = sql.to_ascii_uppercase();
    if let Some(pos) = upper.find(&kw1) {
        let rest = &sql[pos + kw1.len()..];
        let kw2 = first_keyword(rest);
        if kw2.is_empty() {
            kw1
        } else {
            format!("{} {}", kw1, kw2)
        }
    } else {
        kw1
    }
}

/// Render a single jsonb value as a psql-style cell (`None` == SQL NULL).
pub fn json_value_to_cell(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::Bool(b) => Some(if *b { "t" } else { "f" }.to_string()),
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        // Arrays / objects: compact JSON.
        other => Some(other.to_string()),
    }
}

/// Format a sqlx error the way psql prints server errors (two spaces).
pub fn format_pg_error(e: &sqlx::Error) -> String {
    match e {
        sqlx::Error::Database(db) => format!("ERROR:  {}", db.message()),
        other => format!("ERROR:  {}", other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_command_tag_insert() {
        assert_eq!(command_tag("INSERT INTO t VALUES (1)", 3), "INSERT 0 3");
    }

    #[test]
    fn test_command_tag_update_delete() {
        assert_eq!(command_tag("UPDATE t SET x=1", 5), "UPDATE 5");
        assert_eq!(command_tag("delete from t", 2), "DELETE 2");
    }

    #[test]
    fn test_command_tag_transaction_and_set() {
        assert_eq!(command_tag("BEGIN", 0), "BEGIN");
        assert_eq!(command_tag("commit", 0), "COMMIT");
        assert_eq!(command_tag("ROLLBACK", 0), "ROLLBACK");
        assert_eq!(command_tag("SET application_name = 'x'", 0), "SET");
    }

    #[test]
    fn test_command_tag_truncate() {
        assert_eq!(command_tag("TRUNCATE t", 0), "TRUNCATE TABLE");
    }

    #[test]
    fn test_command_tag_ddl_two_words() {
        assert_eq!(command_tag("CREATE TABLE t (i int)", 0), "CREATE TABLE");
        assert_eq!(command_tag("drop index idx", 0), "DROP INDEX");
        assert_eq!(command_tag("ALTER  TABLE t ADD c int", 0), "ALTER TABLE");
    }

    #[test]
    fn test_json_value_to_cell() {
        assert_eq!(json_value_to_cell(&Value::Null), None);
        assert_eq!(json_value_to_cell(&json!(true)), Some("t".to_string()));
        assert_eq!(json_value_to_cell(&json!(false)), Some("f".to_string()));
        assert_eq!(json_value_to_cell(&json!("hi")), Some("hi".to_string()));
        assert_eq!(json_value_to_cell(&json!(42)), Some("42".to_string()));
        assert_eq!(
            json_value_to_cell(&json!([1, 2])),
            Some("[1,2]".to_string())
        );
        assert_eq!(
            json_value_to_cell(&json!({"a":1})),
            Some("{\"a\":1}".to_string())
        );
    }

    #[test]
    fn test_format_pg_error_non_database() {
        let msg = format_pg_error(&sqlx::Error::RowNotFound);
        assert!(msg.starts_with("ERROR:  "));
    }

    #[test]
    fn test_rows_footer() {
        assert_eq!(rows_footer(1), "(1 row)");
        assert_eq!(rows_footer(0), "(0 rows)");
        assert_eq!(rows_footer(2), "(2 rows)");
    }
}
