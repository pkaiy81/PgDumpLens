//! SQL execution against a persistent console connection.
//!
//! Mirrors the classification logic in [`crate::handlers::query`] but targets an
//! already-open, already-configured [`PgConnection`] (no connect / no timeout
//! setup here) and returns structured [`Block`]s instead of a single response.
//!
//! Like psql, one input may hold several `;`-separated statements. The input is
//! split client-side-style by [`split_statements`] (quote-, dollar-quote- and
//! comment-aware) and each statement is sent on its own, because the extended
//! query protocol used by sqlx rejects multiple commands in one prepared
//! statement.

use serde_json::Value;
use sqlx::{Column, Executor, Row};

use super::notice;
use super::session::MAX_ROWS;
use super::Block;
use crate::handlers::query::first_keyword;

/// Execute every statement in `input` in order and render them as console blocks.
///
/// As in psql (without `ON_ERROR_STOP`), a failing statement produces an
/// `error` block and execution continues with the next one. Input made only of
/// whitespace, comments and `;` does nothing.
pub async fn run_sql(conn: &mut sqlx::postgres::PgConnection, input: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    for stmt in split_statements(input) {
        // Like psql, server notices (RAISE NOTICE, "... skipping", ...) are
        // printed before the statement's own result.
        let (result, notices) = notice::with_notices(run_statement(conn, stmt)).await;
        blocks.extend(notices.into_iter().map(|text| Block::Notice { text }));
        blocks.extend(result);
    }
    blocks
}

/// Split SQL text into statements at top-level `;`, the way psql's lexer does.
///
/// Semicolons inside `'...'` / `E'...'` strings, `"..."` identifiers,
/// `$tag$...$tag$` dollar quotes, `--` / nested `/* */` comments and
/// parentheses do not end a statement. Returned slices are trimmed and exclude
/// the terminating `;`; pieces containing only whitespace and comments are
/// dropped. Unterminated quotes/comments run to the end of the input.
pub fn split_statements(input: &str) -> Vec<&str> {
    let b = input.as_bytes();
    let n = b.len();
    let mut out = Vec::new();
    let mut start = 0;
    let mut i = 0;
    let mut paren_depth: usize = 0;
    let mut significant = false;

    while i < n {
        let c = b[i];
        if c == b'-' && i + 1 < n && b[i + 1] == b'-' {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            i = skip_block_comment(b, i);
            continue;
        }
        match c {
            b'\'' => {
                significant = true;
                let escapes = i > 0
                    && (b[i - 1] == b'E' || b[i - 1] == b'e')
                    && (i < 2 || !is_ident_byte(b[i - 2]));
                i = skip_quoted(b, i, b'\'', escapes);
                continue;
            }
            b'"' => {
                significant = true;
                i = skip_quoted(b, i, b'"', false);
                continue;
            }
            b'$' => {
                significant = true;
                if i == 0 || !is_ident_byte(b[i - 1]) {
                    if let Some(tag_end) = dollar_tag_end(b, i) {
                        let tag = &input[i..tag_end];
                        i = match input[tag_end..].find(tag) {
                            Some(pos) => tag_end + pos + tag.len(),
                            None => n,
                        };
                        continue;
                    }
                }
            }
            b'(' => {
                significant = true;
                paren_depth += 1;
            }
            b')' => {
                significant = true;
                paren_depth = paren_depth.saturating_sub(1);
            }
            b';' if paren_depth == 0 => {
                if significant {
                    out.push(input[start..i].trim());
                }
                start = i + 1;
                significant = false;
            }
            c if c.is_ascii_whitespace() => {}
            _ => significant = true,
        }
        i += 1;
    }
    if significant {
        out.push(input[start..].trim());
    }
    out
}

/// Bytes that may appear inside an unquoted identifier (non-ASCII included).
fn is_ident_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80
}

/// Skip a (possibly nested) `/* */` comment starting at `i`; returns the index
/// just past it, or the input length if unterminated.
fn skip_block_comment(b: &[u8], mut i: usize) -> usize {
    let n = b.len();
    let mut depth = 0usize;
    while i < n {
        if b[i] == b'/' && i + 1 < n && b[i + 1] == b'*' {
            depth += 1;
            i += 2;
        } else if b[i] == b'*' && i + 1 < n && b[i + 1] == b'/' {
            depth -= 1;
            i += 2;
            if depth == 0 {
                return i;
            }
        } else {
            i += 1;
        }
    }
    n
}

/// Skip a quoted literal opening at `i` with quote byte `q` (doubled quote is
/// an escaped quote; with `backslash`, `\x` is also an escape). Returns the
/// index just past the closing quote, or the input length if unterminated.
fn skip_quoted(b: &[u8], i: usize, q: u8, backslash: bool) -> usize {
    let n = b.len();
    let mut j = i + 1;
    while j < n {
        if backslash && b[j] == b'\\' {
            j += 2;
        } else if b[j] == q {
            if j + 1 < n && b[j + 1] == q {
                j += 2;
            } else {
                return j + 1;
            }
        } else {
            j += 1;
        }
    }
    n
}

/// If a dollar-quote opening tag (`$$` or `$ident$`) starts at `i`, return the
/// index just past it.
fn dollar_tag_end(b: &[u8], i: usize) -> Option<usize> {
    let n = b.len();
    let mut j = i + 1;
    if j < n && b[j] == b'$' {
        return Some(j + 1);
    }
    if j >= n || !(b[j].is_ascii_alphabetic() || b[j] == b'_' || b[j] >= 0x80) {
        return None;
    }
    while j < n && (b[j].is_ascii_alphanumeric() || b[j] == b'_' || b[j] >= 0x80) {
        j += 1;
    }
    if j < n && b[j] == b'$' {
        Some(j + 1)
    } else {
        None
    }
}

/// Execute one SQL statement and render it as console blocks.
///
/// SQL errors are returned as an `error` block (never an `Err`) so the session
/// stays alive, matching psql's behaviour.
async fn run_statement(conn: &mut sqlx::postgres::PgConnection, sql: &str) -> Vec<Block> {
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
///
/// sqlx does not expose the server's command tag, so it is reconstructed from
/// the statement's top-level keywords (matching what PostgreSQL 16 reports).
pub fn command_tag(sql: &str, n: u64) -> String {
    let w = top_level_words(sql);
    let at = |i: usize| w.get(i).map(String::as_str).unwrap_or("");
    let kw = at(0);
    match kw {
        "INSERT" => format!("INSERT 0 {}", n),
        "UPDATE" | "DELETE" | "MERGE" | "COPY" | "FETCH" | "MOVE" => format!("{} {}", kw, n),
        // `SELECT ... INTO` creates a table and reports the row count.
        "SELECT" | "TABLE" | "VALUES" => format!("SELECT {}", n),
        // Data-modifying CTE without RETURNING: tag of the main statement
        // (CTE bodies are parenthesized, so they are not top-level words).
        "WITH" => match w
            .iter()
            .skip(1)
            .map(String::as_str)
            .find(|x| matches!(*x, "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "SELECT"))
        {
            Some("INSERT") => format!("INSERT 0 {}", n),
            Some(other) => format!("{} {}", other, n),
            None => format!("SELECT {}", n),
        },
        "START" => "START TRANSACTION".to_string(),
        "END" => "COMMIT".to_string(),
        "ABORT" => "ROLLBACK".to_string(),
        "COMMIT" | "ROLLBACK" if at(1) == "PREPARED" => format!("{} PREPARED", kw),
        "PREPARE" if at(1) == "TRANSACTION" => "PREPARE TRANSACTION".to_string(),
        "TRUNCATE" => "TRUNCATE TABLE".to_string(),
        "LOCK" => "LOCK TABLE".to_string(),
        "ANALYSE" => "ANALYZE".to_string(),
        "SET" if at(1) == "CONSTRAINTS" => "SET CONSTRAINTS".to_string(),
        "DEALLOCATE" if at(1) == "ALL" => "DEALLOCATE ALL".to_string(),
        "DISCARD" => match at(1) {
            "TEMPORARY" => "DISCARD TEMP".to_string(),
            "" => kw.to_string(),
            other => format!("DISCARD {}", other),
        },
        "REFRESH" => "REFRESH MATERIALIZED VIEW".to_string(),
        "SECURITY" => "SECURITY LABEL".to_string(),
        "IMPORT" => "IMPORT FOREIGN SCHEMA".to_string(),
        "REASSIGN" => "REASSIGN OWNED".to_string(),
        "CREATE" | "ALTER" | "DROP" => ddl_tag(&w, n),
        _ => kw.to_string(),
    }
}

/// Command tag for `CREATE` / `ALTER` / `DROP` (`w` = top-level words).
fn ddl_tag(w: &[String], n: u64) -> String {
    let at = |i: usize| w.get(i).map(String::as_str).unwrap_or("");
    let verb = at(0);
    let mut i = 1;
    if verb == "CREATE" {
        // Modifiers that do not appear in the tag (CREATE TEMP TABLE -> CREATE TABLE).
        while matches!(
            at(i),
            "OR" | "REPLACE"
                | "TEMP"
                | "TEMPORARY"
                | "GLOBAL"
                | "LOCAL"
                | "UNLOGGED"
                | "UNIQUE"
                | "RECURSIVE"
                | "TRUSTED"
                | "PROCEDURAL"
                | "DEFAULT"
                | "CONSTRAINT"
        ) {
            i += 1;
        }
    }
    let object = match (at(i), at(i + 1)) {
        ("MATERIALIZED", "VIEW")
        | ("FOREIGN", "TABLE")
        | ("EVENT", "TRIGGER")
        | ("USER", "MAPPING")
        | ("OPERATOR", "CLASS")
        | ("OPERATOR", "FAMILY")
        | ("ACCESS", "METHOD")
        | ("DEFAULT", "PRIVILEGES") => format!("{} {}", at(i), at(i + 1)),
        ("FOREIGN", "DATA") => "FOREIGN DATA WRAPPER".to_string(),
        ("TEXT", "SEARCH") => format!("TEXT SEARCH {}", at(i + 2)),
        ("USER", _) | ("GROUP", _) => "ROLE".to_string(),
        (o, _) => o.to_string(),
    };

    // CREATE TABLE ... AS / CREATE MATERIALIZED VIEW ... AS report "SELECT n",
    // unless WITH NO DATA.
    if verb == "CREATE"
        && (object == "TABLE" || object == "MATERIALIZED VIEW")
        && w.iter().any(|x| x == "AS")
    {
        let no_data = w.len() >= 3 && w[w.len() - 3..] == ["WITH", "NO", "DATA"];
        return match (no_data, object.as_str()) {
            (false, _) => format!("SELECT {}", n),
            (true, "TABLE") => "CREATE TABLE AS".to_string(),
            (true, _) => "CREATE MATERIALIZED VIEW".to_string(),
        };
    }

    if object.is_empty() {
        verb.to_string()
    } else {
        format!("{} {}", verb, object)
    }
}

/// Uppercased unquoted words outside parentheses, skipping strings, quoted
/// identifiers, dollar quotes, comments and numbers.
fn top_level_words(sql: &str) -> Vec<String> {
    let b = sql.as_bytes();
    let n = b.len();
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut i = 0;
    while i < n {
        let c = b[i];
        if c == b'-' && i + 1 < n && b[i + 1] == b'-' {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
        } else if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            i = skip_block_comment(b, i);
        } else if c == b'\'' || c == b'"' {
            i = skip_quoted(b, i, c, false);
        } else if c == b'$' {
            match dollar_tag_end(b, i) {
                Some(tag_end) => {
                    let tag = &sql[i..tag_end];
                    i = match sql[tag_end..].find(tag) {
                        Some(pos) => tag_end + pos + tag.len(),
                        None => n,
                    };
                }
                None => i += 1,
            }
        } else if c == b'(' {
            depth += 1;
            i += 1;
        } else if c == b')' {
            depth = depth.saturating_sub(1);
            i += 1;
        } else if is_ident_byte(c) {
            let start = i;
            while i < n && is_ident_byte(b[i]) {
                i += 1;
            }
            let first = b[start];
            if depth == 0 && (first.is_ascii_alphabetic() || first == b'_' || first >= 0x80) {
                out.push(sql[start..i].to_ascii_uppercase());
            }
        } else {
            i += 1;
        }
    }
    out
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
    fn test_command_tag_matches_postgres() {
        // Expected tags captured from PostgreSQL 16 via psql.
        let cases: &[(&str, u64, &str)] = &[
            ("CREATE TEMP TABLE tt (i int)", 0, "CREATE TABLE"),
            ("CREATE TEMPORARY TABLE tt2 (i int)", 0, "CREATE TABLE"),
            ("CREATE UNLOGGED TABLE ut (i int)", 0, "CREATE TABLE"),
            ("CREATE TABLE IF NOT EXISTS t (i int)", 0, "CREATE TABLE"),
            ("CREATE TABLE t (i int GENERATED ALWAYS AS IDENTITY, v text DEFAULT 'a')", 0, "CREATE TABLE"),
            ("CREATE TABLE ta AS SELECT 1 AS x UNION SELECT 2", 2, "SELECT 2"),
            ("CREATE TABLE tb (x) AS SELECT 1", 1, "SELECT 1"),
            ("CREATE TABLE IF NOT EXISTS t2 AS SELECT 1", 1, "SELECT 1"),
            ("CREATE TABLE tc AS SELECT 1 AS x WITH NO DATA", 0, "CREATE TABLE AS"),
            ("SELECT 1 AS x INTO td", 1, "SELECT 1"),
            ("CREATE MATERIALIZED VIEW mv AS SELECT 1 AS x", 1, "SELECT 1"),
            ("CREATE MATERIALIZED VIEW mv2 AS SELECT 1 AS x WITH NO DATA", 0, "CREATE MATERIALIZED VIEW"),
            ("REFRESH MATERIALIZED VIEW mv", 0, "REFRESH MATERIALIZED VIEW"),
            ("CREATE OR REPLACE VIEW v AS SELECT 1 AS x", 0, "CREATE VIEW"),
            ("CREATE OR REPLACE TEMP VIEW tv2 AS SELECT 1", 0, "CREATE VIEW"),
            ("CREATE RECURSIVE VIEW rv (n) AS VALUES (1)", 0, "CREATE VIEW"),
            ("CREATE UNIQUE INDEX ui ON t (v)", 0, "CREATE INDEX"),
            ("CREATE INDEX CONCURRENTLY ci ON t (v)", 0, "CREATE INDEX"),
            ("CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql", 0, "CREATE FUNCTION"),
            ("CREATE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$", 0, "CREATE PROCEDURE"),
            ("CREATE TEMP SEQUENCE ts", 0, "CREATE SEQUENCE"),
            ("CREATE FOREIGN DATA WRAPPER fdw", 0, "CREATE FOREIGN DATA WRAPPER"),
            ("CREATE TEXT SEARCH CONFIGURATION tsc (COPY = simple)", 0, "CREATE TEXT SEARCH CONFIGURATION"),
            ("CREATE CONSTRAINT TRIGGER ctr AFTER INSERT ON t DEFERRABLE FOR EACH ROW EXECUTE FUNCTION g()", 0, "CREATE TRIGGER"),
            ("CREATE USER u2", 0, "CREATE ROLE"),
            ("WITH x AS (SELECT 1) INSERT INTO t (v) SELECT 'b' FROM x", 1, "INSERT 0 1"),
            ("WITH x AS (SELECT 1) UPDATE t SET v = 'c'", 0, "UPDATE 0"),
            ("MERGE INTO t USING (SELECT 'q' AS v) s ON t.v = s.v WHEN NOT MATCHED THEN INSERT (v) VALUES (s.v)", 1, "MERGE 1"),
            ("ALTER TABLE IF EXISTS t DROP COLUMN w", 0, "ALTER TABLE"),
            ("ALTER MATERIALIZED VIEW mv RENAME TO mv3", 0, "ALTER MATERIALIZED VIEW"),
            ("ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO r1", 0, "ALTER DEFAULT PRIVILEGES"),
            ("ALTER FOREIGN DATA WRAPPER fdw OPTIONS (ADD a '1')", 0, "ALTER FOREIGN DATA WRAPPER"),
            ("DO $$ BEGIN RAISE NOTICE 'hi'; END $$", 0, "DO"),
            ("CALL p()", 0, "CALL"),
            ("START TRANSACTION", 0, "START TRANSACTION"),
            ("BEGIN ISOLATION LEVEL SERIALIZABLE", 0, "BEGIN"),
            ("RELEASE SAVEPOINT sp", 0, "RELEASE"),
            ("ROLLBACK TO SAVEPOINT sp", 0, "ROLLBACK"),
            ("END", 0, "COMMIT"),
            ("ABORT", 0, "ROLLBACK"),
            ("SET LOCAL work_mem = '8MB'", 0, "SET"),
            ("SET CONSTRAINTS ALL DEFERRED", 0, "SET CONSTRAINTS"),
            ("DISCARD TEMP", 0, "DISCARD TEMP"),
            ("DISCARD ALL", 0, "DISCARD ALL"),
            ("DEALLOCATE ps", 0, "DEALLOCATE"),
            ("DEALLOCATE ALL", 0, "DEALLOCATE ALL"),
            ("LOCK TABLE t", 0, "LOCK TABLE"),
            ("DROP TABLE IF EXISTS ta, tb", 0, "DROP TABLE"),
            ("DROP MATERIALIZED VIEW mv3", 0, "DROP MATERIALIZED VIEW"),
            ("DROP TEXT SEARCH CONFIGURATION tsc", 0, "DROP TEXT SEARCH CONFIGURATION"),
            ("DROP OWNED BY r1", 0, "DROP OWNED"),
            ("REINDEX TABLE t", 0, "REINDEX"),
            ("COMMENT ON TABLE t IS 'x'", 0, "COMMENT"),
        ];
        for (sql, n, want) in cases {
            assert_eq!(command_tag(sql, *n), *want, "for {:?}", sql);
        }
    }

    #[test]
    fn test_top_level_words() {
        assert_eq!(
            top_level_words("create /* c */ table \"Q\" (a int default 'x as y') -- as\n as select $$ as $$, 1e5"),
            vec!["CREATE", "TABLE", "AS", "SELECT"]
        );
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
    fn test_split_basic() {
        assert_eq!(
            split_statements("SELECT 1; SELECT 2;"),
            vec!["SELECT 1", "SELECT 2"]
        );
        assert_eq!(split_statements("SELECT 1"), vec!["SELECT 1"]);
        assert_eq!(
            split_statements("  select 1 ;\n\n update t set a = 1 ; "),
            vec!["select 1", "update t set a = 1"]
        );
    }

    #[test]
    fn test_split_skips_empty_and_comment_only() {
        assert!(split_statements("").is_empty());
        assert!(split_statements(" ; ;; ").is_empty());
        assert!(split_statements("-- just a comment\n/* and this */;").is_empty());
        assert_eq!(
            split_statements("SELECT 1; -- trailing note"),
            vec!["SELECT 1"]
        );
    }

    #[test]
    fn test_split_respects_quotes() {
        assert_eq!(
            split_statements("SELECT 'a;b'; SELECT 2"),
            vec!["SELECT 'a;b'", "SELECT 2"]
        );
        assert_eq!(
            split_statements("SELECT 'it''s;'; SELECT 2"),
            vec!["SELECT 'it''s;'", "SELECT 2"]
        );
        assert_eq!(
            split_statements(r"SELECT E'\';'; SELECT 2"),
            vec![r"SELECT E'\';'", "SELECT 2"]
        );
        assert_eq!(
            split_statements(r"SELECT 'a\'; SELECT 2"),
            vec![r"SELECT 'a\'", "SELECT 2"]
        );
        assert_eq!(
            split_statements(r#"SELECT 1 AS "x;y"; SELECT 2"#),
            vec![r#"SELECT 1 AS "x;y""#, "SELECT 2"]
        );
    }

    #[test]
    fn test_split_respects_comments() {
        assert_eq!(
            split_statements("SELECT 1 -- a;b\n; SELECT 2"),
            vec!["SELECT 1 -- a;b", "SELECT 2"]
        );
        assert_eq!(
            split_statements("SELECT /* a; /* nested; */ b; */ 1; SELECT 2"),
            vec!["SELECT /* a; /* nested; */ b; */ 1", "SELECT 2"]
        );
    }

    #[test]
    fn test_split_respects_dollar_quotes() {
        let f =
            "CREATE FUNCTION f() RETURNS int AS $$\nBEGIN\n  RETURN 1;\nEND;\n$$ LANGUAGE plpgsql";
        let input = format!("{};\nSELECT f();", f);
        assert_eq!(split_statements(&input), vec![f, "SELECT f()"]);

        let tagged = "DO $body$ BEGIN PERFORM '$$;'; END $body$";
        assert_eq!(
            split_statements(&format!("{}; SELECT 1", tagged)),
            vec![tagged, "SELECT 1"]
        );

        // `$1` parameters and `$` inside identifiers are not dollar quotes.
        assert_eq!(
            split_statements("SELECT $1; SELECT a$b$; SELECT 2"),
            vec!["SELECT $1", "SELECT a$b$", "SELECT 2"]
        );
    }

    #[test]
    fn test_split_respects_parentheses() {
        assert_eq!(
            split_statements(
                "CREATE RULE r AS ON INSERT TO t DO ALSO (SELECT 1; SELECT 2); SELECT 3"
            ),
            vec![
                "CREATE RULE r AS ON INSERT TO t DO ALSO (SELECT 1; SELECT 2)",
                "SELECT 3"
            ]
        );
    }

    #[test]
    fn test_split_unterminated_runs_to_end() {
        assert_eq!(
            split_statements("SELECT 'abc; SELECT 2"),
            vec!["SELECT 'abc; SELECT 2"]
        );
        assert_eq!(split_statements("DO $$ BEGIN; "), vec!["DO $$ BEGIN;"]);
    }

    #[test]
    fn test_rows_footer() {
        assert_eq!(rows_footer(1), "(1 row)");
        assert_eq!(rows_footer(0), "(0 rows)");
        assert_eq!(rows_footer(2), "(2 rows)");
    }
}
