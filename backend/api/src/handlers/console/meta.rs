//! psql-style meta-command parsing and execution.
//!
//! Meta-commands are implemented as catalog queries against the session's
//! persistent connection (there is no real psql binary). Errors are surfaced as
//! `error`/`notice` blocks so the session stays alive.

use sqlx::postgres::{PgConnection, PgRow};
use sqlx::{Connection, Row};

use super::session::{open_session_conn, ConsoleSession};
use super::sql::format_pg_error;
use super::Block;
use crate::handlers::sandbox::{extract_original_db_name, resolve_sandbox_db};
use crate::state::AppState;

/// A parsed meta-command (leading `\`).
#[derive(Debug, PartialEq, Eq)]
pub enum MetaCommand {
    ListDatabases,
    Connect(Option<String>),
    Describe(Option<String>),
    ListTables(Option<String>),
    ListSchemas,
    ListViews(Option<String>),
    ListIndexes(Option<String>),
    ListFunctions(Option<String>),
    ToggleExpanded,
    ToggleTiming(Option<bool>),
    Help,
    Quit,
    Unknown(String),
}

/// Parse a single `\`-prefixed line into a [`MetaCommand`].
pub fn parse_meta(line: &str) -> MetaCommand {
    let line = line.trim();
    let mut parts = line.splitn(2, char::is_whitespace);
    let cmd = parts.next().unwrap_or("");
    let arg = parts
        .next()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    match cmd {
        "\\l" | "\\list" => MetaCommand::ListDatabases,
        "\\c" | "\\connect" => MetaCommand::Connect(arg),
        "\\d" => MetaCommand::Describe(arg),
        "\\dt" => MetaCommand::ListTables(arg),
        "\\dn" => MetaCommand::ListSchemas,
        "\\dv" => MetaCommand::ListViews(arg),
        "\\di" => MetaCommand::ListIndexes(arg),
        "\\df" => MetaCommand::ListFunctions(arg),
        "\\x" => MetaCommand::ToggleExpanded,
        "\\timing" => {
            let v = match arg.as_deref() {
                Some("on") => Some(true),
                Some("off") => Some(false),
                _ => None,
            };
            MetaCommand::ToggleTiming(v)
        }
        "\\?" => MetaCommand::Help,
        "\\q" | "\\quit" => MetaCommand::Quit,
        other => MetaCommand::Unknown(other.to_string()),
    }
}

/// Translate a psql name pattern into a SQL `LIKE` pattern.
///
/// `*` -> `%`, `?` -> `_`, and literal `%`/`_`/`\` are backslash-escaped.
pub fn pattern_to_like(p: &str) -> String {
    let mut out = String::new();
    for ch in p.chars() {
        match ch {
            '*' => out.push('%'),
            '?' => out.push('_'),
            '%' | '_' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            other => out.push(other),
        }
    }
    out
}

/// Read every column of every row as text (`None` == SQL NULL).
fn rows_as_text(raw: &[PgRow], ncols: usize) -> Vec<Vec<Option<String>>> {
    raw.iter()
        .map(|row| {
            (0..ncols)
                .map(|i| row.try_get::<Option<String>, _>(i).ok().flatten())
                .collect()
        })
        .collect()
}

/// Static case labels for `pg_class.relkind`.
const RELKIND_CASE: &str = "CASE c.relkind \
    WHEN 'r' THEN 'table' \
    WHEN 'p' THEN 'partitioned table' \
    WHEN 'v' THEN 'view' \
    WHEN 'm' THEN 'materialized view' \
    WHEN 'S' THEN 'sequence' \
    WHEN 'f' THEN 'foreign table' \
    WHEN 'i' THEN 'index' \
    WHEN 'I' THEN 'partitioned index' \
    ELSE c.relkind::text END";

/// List relations of the given `relkind`s as a `Schema/Name/Type/Owner` table.
async fn list_relations(
    conn: &mut PgConnection,
    relkinds: &str,
    pattern: Option<&str>,
    empty_msg: &str,
    expanded: bool,
) -> Vec<Block> {
    let mut q = format!(
        "SELECT n.nspname::text, c.relname::text, {case}, \
         pg_catalog.pg_get_userbyid(c.relowner)::text \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relkind IN ({relkinds}) \
         AND n.nspname NOT IN ('pg_catalog','information_schema') \
         AND n.nspname !~ '^pg_toast'",
        case = RELKIND_CASE,
        relkinds = relkinds,
    );
    if pattern.is_some() {
        q.push_str(" AND c.relname LIKE $1");
    }
    q.push_str(" ORDER BY 1, 2");

    let mut query = sqlx::query(&q);
    if let Some(p) = pattern {
        query = query.bind(pattern_to_like(p));
    }
    match query.fetch_all(&mut *conn).await {
        Ok(raw) => {
            if raw.is_empty() {
                return vec![Block::Text {
                    text: empty_msg.to_string(),
                }];
            }
            let rows = rows_as_text(&raw, 4);
            let footer = Some(row_count_footer(rows.len()));
            vec![Block::Table {
                columns: vec![
                    "Schema".into(),
                    "Name".into(),
                    "Type".into(),
                    "Owner".into(),
                ],
                rows,
                footer,
                expanded,
            }]
        }
        Err(e) => vec![Block::Error {
            text: format_pg_error(&e),
        }],
    }
}

/// `(N rows)` / `(1 row)` footer for meta-command listings.
fn row_count_footer(n: usize) -> String {
    if n == 1 {
        "(1 row)".to_string()
    } else {
        format!("({} rows)", n)
    }
}

/// Execute a meta-command. Returns rendered blocks and whether the session ended.
pub async fn run_meta(
    cmd: MetaCommand,
    session: &mut ConsoleSession,
    state: &AppState,
) -> (Vec<Block>, bool) {
    match cmd {
        MetaCommand::ListDatabases => (list_databases(session, state).await, false),
        MetaCommand::ListTables(pat) => (
            list_relations(
                &mut session.conn,
                "'r','p'",
                pat.as_deref(),
                "Did not find any relations.",
                session.expanded,
            )
            .await,
            false,
        ),
        MetaCommand::ListViews(pat) => (
            list_relations(
                &mut session.conn,
                "'v','m'",
                pat.as_deref(),
                "Did not find any relations.",
                session.expanded,
            )
            .await,
            false,
        ),
        MetaCommand::Describe(None) => (
            list_relations(
                &mut session.conn,
                "'r','p','v','m','S','f'",
                None,
                "Did not find any relations.",
                session.expanded,
            )
            .await,
            false,
        ),
        MetaCommand::ListIndexes(pat) => (list_indexes(session, pat.as_deref()).await, false),
        MetaCommand::ListSchemas => (list_schemas(session).await, false),
        MetaCommand::ListFunctions(pat) => (list_functions(session, pat.as_deref()).await, false),
        MetaCommand::Describe(Some(name)) => (describe_relation(session, &name).await, false),
        MetaCommand::Connect(arg) => (connect(session, state, arg).await, false),
        MetaCommand::ToggleExpanded => {
            session.expanded = !session.expanded;
            let text = if session.expanded {
                "Expanded display is on."
            } else {
                "Expanded display is off."
            };
            (
                vec![Block::Text {
                    text: text.to_string(),
                }],
                false,
            )
        }
        MetaCommand::ToggleTiming(v) => {
            session.timing = v.unwrap_or(!session.timing);
            let text = if session.timing {
                "Timing is on."
            } else {
                "Timing is off."
            };
            (
                vec![Block::Text {
                    text: text.to_string(),
                }],
                false,
            )
        }
        MetaCommand::Help => (
            vec![Block::Text {
                text: HELP_TEXT.to_string(),
            }],
            false,
        ),
        MetaCommand::Quit => (vec![], true),
        MetaCommand::Unknown(cmd) => (
            vec![Block::Error {
                text: format!("invalid command {}. Try \\? for help.", cmd),
            }],
            false,
        ),
    }
}

/// `\l` — list the dump's databases, marking the current one.
async fn list_databases(session: &mut ConsoleSession, state: &AppState) -> Vec<Block> {
    let row = sqlx::query("SELECT sandbox_db_name, sandbox_databases FROM dumps WHERE id = $1")
        .bind(session.dump_id)
        .fetch_optional(&state.db_pool)
        .await;
    match row {
        Ok(Some(r)) => {
            let primary: Option<String> = r.get("sandbox_db_name");
            let dbs: Option<Vec<String>> = r.get("sandbox_databases");
            let list = dbs.unwrap_or_else(|| primary.clone().map_or_else(Vec::new, |p| vec![p]));
            let friendly: Vec<String> = list.iter().map(|d| extract_original_db_name(d)).collect();
            let rows: Vec<Vec<Option<String>>> = friendly
                .iter()
                .map(|name| {
                    let current = if *name == session.database { "*" } else { "" };
                    vec![Some(name.clone()), Some(current.to_string())]
                })
                .collect();
            vec![
                Block::Text {
                    text: "List of databases".to_string(),
                },
                Block::Table {
                    columns: vec!["Name".into(), "Current".into()],
                    rows,
                    footer: None,
                    expanded: session.expanded,
                },
            ]
        }
        Ok(None) => vec![Block::Error {
            text: "ERROR:  dump not found".to_string(),
        }],
        Err(e) => vec![Block::Error {
            text: format_pg_error(&e),
        }],
    }
}

/// `\dn` — list schemas.
async fn list_schemas(session: &mut ConsoleSession) -> Vec<Block> {
    let q = "SELECT n.nspname::text, pg_catalog.pg_get_userbyid(n.nspowner)::text \
             FROM pg_catalog.pg_namespace n \
             WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' \
             ORDER BY 1";
    match sqlx::query(q).fetch_all(&mut session.conn).await {
        Ok(raw) => {
            if raw.is_empty() {
                return vec![Block::Text {
                    text: "Did not find any schemas.".to_string(),
                }];
            }
            let rows = rows_as_text(&raw, 2);
            let footer = Some(row_count_footer(rows.len()));
            vec![Block::Table {
                columns: vec!["Name".into(), "Owner".into()],
                rows,
                footer,
                expanded: session.expanded,
            }]
        }
        Err(e) => vec![Block::Error {
            text: format_pg_error(&e),
        }],
    }
}

/// `\di` — list indexes with their base table.
async fn list_indexes(session: &mut ConsoleSession, pattern: Option<&str>) -> Vec<Block> {
    let mut q = "SELECT n.nspname::text, c.relname::text, \
         CASE c.relkind WHEN 'i' THEN 'index' WHEN 'I' THEN 'partitioned index' \
         ELSE c.relkind::text END, \
         pg_catalog.pg_get_userbyid(c.relowner)::text, t.relname::text \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid \
         JOIN pg_catalog.pg_class t ON t.oid = i.indrelid \
         WHERE c.relkind IN ('i','I') \
         AND n.nspname NOT IN ('pg_catalog','information_schema') \
         AND n.nspname !~ '^pg_toast'"
        .to_string();
    if pattern.is_some() {
        q.push_str(" AND c.relname LIKE $1");
    }
    q.push_str(" ORDER BY 1, 2");

    let mut query = sqlx::query(&q);
    if let Some(p) = pattern {
        query = query.bind(pattern_to_like(p));
    }
    match query.fetch_all(&mut session.conn).await {
        Ok(raw) => {
            if raw.is_empty() {
                return vec![Block::Text {
                    text: "Did not find any relations.".to_string(),
                }];
            }
            let rows = rows_as_text(&raw, 5);
            let footer = Some(row_count_footer(rows.len()));
            vec![Block::Table {
                columns: vec![
                    "Schema".into(),
                    "Name".into(),
                    "Type".into(),
                    "Owner".into(),
                    "Table".into(),
                ],
                rows,
                footer,
                expanded: session.expanded,
            }]
        }
        Err(e) => vec![Block::Error {
            text: format_pg_error(&e),
        }],
    }
}

/// `\df` — list functions.
async fn list_functions(session: &mut ConsoleSession, pattern: Option<&str>) -> Vec<Block> {
    let mut q = "SELECT n.nspname::text, p.proname::text, \
         pg_catalog.pg_get_function_result(p.oid)::text, \
         pg_catalog.pg_get_function_arguments(p.oid)::text, \
         CASE p.prokind WHEN 'a' THEN 'agg' WHEN 'w' THEN 'window' \
         WHEN 'p' THEN 'proc' ELSE 'func' END \
         FROM pg_catalog.pg_proc p \
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname NOT IN ('pg_catalog','information_schema')"
        .to_string();
    if pattern.is_some() {
        q.push_str(" AND p.proname LIKE $1");
    }
    q.push_str(" ORDER BY 1, 2, 4");

    let mut query = sqlx::query(&q);
    if let Some(p) = pattern {
        query = query.bind(pattern_to_like(p));
    }
    match query.fetch_all(&mut session.conn).await {
        Ok(raw) => {
            if raw.is_empty() {
                return vec![Block::Text {
                    text: "Did not find any functions.".to_string(),
                }];
            }
            let rows = rows_as_text(&raw, 5);
            let footer = Some(row_count_footer(rows.len()));
            vec![Block::Table {
                columns: vec![
                    "Schema".into(),
                    "Name".into(),
                    "Result data type".into(),
                    "Argument data types".into(),
                    "Type".into(),
                ],
                rows,
                footer,
                expanded: session.expanded,
            }]
        }
        Err(e) => vec![Block::Error {
            text: format_pg_error(&e),
        }],
    }
}

/// `\d name` — describe a single relation.
async fn describe_relation(session: &mut ConsoleSession, name: &str) -> Vec<Block> {
    // Split an optional schema qualifier.
    let (schema, relname) = match name.split_once('.') {
        Some((s, r)) => (Some(s.to_string()), r.to_string()),
        None => (None, name.to_string()),
    };

    // Resolve the relation oid, kind and actual schema.
    let resolved: Result<Option<PgRow>, sqlx::Error> = if let Some(ref s) = schema {
        sqlx::query(
            "SELECT c.oid::int8, c.relkind::text, n.nspname::text \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relname = $1 AND n.nspname = $2 LIMIT 1",
        )
        .bind(&relname)
        .bind(s)
        .fetch_optional(&mut session.conn)
        .await
    } else {
        sqlx::query(
            "SELECT c.oid::int8, c.relkind::text, n.nspname::text \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relname = $1 AND pg_catalog.pg_table_is_visible(c.oid) LIMIT 1",
        )
        .bind(&relname)
        .fetch_optional(&mut session.conn)
        .await
    };

    let row = match resolved {
        Ok(Some(r)) => r,
        Ok(None) => {
            return vec![Block::Error {
                text: format!("Did not find any relation named \"{}\".", name),
            }]
        }
        Err(e) => {
            return vec![Block::Error {
                text: format_pg_error(&e),
            }]
        }
    };

    let oid: i64 = row.get(0);
    let relkind: String = row.get(1);
    let nspname: String = row.get(2);
    let qualified = format!("{}.{}", nspname, relname);

    let mut blocks = Vec::new();

    // 1. Title.
    let label = match relkind.as_str() {
        "r" | "p" => "Table",
        "v" => "View",
        "m" => "Materialized view",
        "S" => "Sequence",
        "f" => "Foreign table",
        "i" | "I" => "Index",
        "c" => "Composite type",
        _ => "Relation",
    };
    blocks.push(Block::Text {
        text: format!("{} \"{}\"", label, qualified),
    });

    // 2. Column list.
    match sqlx::query(
        "SELECT a.attname::text, \
         pg_catalog.format_type(a.atttypid, a.atttypmod)::text, \
         coll.collname::text, \
         CASE WHEN a.attnotnull THEN 'not null' ELSE '' END::text, \
         pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)::text \
         FROM pg_catalog.pg_attribute a \
         LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
         LEFT JOIN pg_catalog.pg_type t ON t.oid = a.atttypid \
         LEFT JOIN pg_catalog.pg_collation coll ON coll.oid = a.attcollation \
         AND a.attcollation <> t.typcollation \
         WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum",
    )
    .bind(oid)
    .fetch_all(&mut session.conn)
    .await
    {
        Ok(raw) => {
            let rows = rows_as_text(&raw, 5);
            blocks.push(Block::Table {
                columns: vec![
                    "Column".into(),
                    "Type".into(),
                    "Collation".into(),
                    "Nullable".into(),
                    "Default".into(),
                ],
                rows,
                footer: None,
                expanded: session.expanded,
            });
        }
        Err(e) => {
            return vec![Block::Error {
                text: format_pg_error(&e),
            }]
        }
    }

    // 3. Indexes (tables / partitioned tables / materialized views only).
    if matches!(relkind.as_str(), "r" | "p" | "m") {
        if let Ok(raw) = sqlx::query(
            "SELECT c2.relname::text, i.indisprimary, i.indisunique, \
             pg_catalog.pg_get_indexdef(i.indexrelid, 0, true)::text \
             FROM pg_catalog.pg_index i \
             JOIN pg_catalog.pg_class c2 ON c2.oid = i.indexrelid \
             WHERE i.indrelid = $1::oid \
             ORDER BY c2.relname",
        )
        .bind(oid)
        .fetch_all(&mut session.conn)
        .await
        {
            if !raw.is_empty() {
                let mut lines = vec!["Indexes:".to_string()];
                for r in &raw {
                    let iname: String = r.get(0);
                    let is_primary: bool = r.get(1);
                    let is_unique: bool = r.get(2);
                    let indexdef: String = r.get(3);
                    let kind = if is_primary {
                        "PRIMARY KEY, "
                    } else if is_unique {
                        "UNIQUE, "
                    } else {
                        ""
                    };
                    let using = indexdef
                        .find(" USING ")
                        .map(|p| &indexdef[p + 7..])
                        .unwrap_or(&indexdef);
                    lines.push(format!("    \"{}\" {}{}", iname, kind, using));
                }
                blocks.push(Block::Text {
                    text: lines.join("\n"),
                });
            }
        }
    }

    // 4. Foreign-key constraints.
    if let Ok(raw) = sqlx::query(
        "SELECT conname::text, pg_catalog.pg_get_constraintdef(oid, true)::text \
         FROM pg_catalog.pg_constraint \
         WHERE conrelid = $1::oid AND contype = 'f' \
         ORDER BY conname",
    )
    .bind(oid)
    .fetch_all(&mut session.conn)
    .await
    {
        if !raw.is_empty() {
            let mut lines = vec!["Foreign-key constraints:".to_string()];
            for r in &raw {
                let conname: String = r.get(0);
                let condef: String = r.get(1);
                lines.push(format!("    \"{}\" {}", conname, condef));
            }
            blocks.push(Block::Text {
                text: lines.join("\n"),
            });
        }
    }

    blocks
}

/// `\c [db]` — reconnect to another database of the same dump.
async fn connect(
    session: &mut ConsoleSession,
    state: &AppState,
    arg: Option<String>,
) -> Vec<Block> {
    let Some(db) = arg else {
        return vec![Block::Notice {
            text: format!(
                "You are now connected to database \"{}\" as user \"{}\".",
                session.database, state.config.sandbox_user
            ),
        }];
    };

    let sandbox_db = match resolve_sandbox_db(&state.db_pool, session.dump_id, Some(&db)).await {
        Ok(s) => s,
        // Keep the old connection alive, matching psql behaviour.
        Err(e) => {
            return vec![Block::Error {
                text: format!("ERROR:  {}", e),
            }]
        }
    };

    let new_conn = match open_session_conn(&state.config, &sandbox_db).await {
        Ok(c) => c,
        Err(e) => {
            return vec![Block::Error {
                text: format!("ERROR:  {}", e),
            }]
        }
    };

    let old = std::mem::replace(&mut session.conn, new_conn);
    let _ = old.close().await;
    session.sandbox_db = sandbox_db;
    session.database = db.clone();

    vec![Block::Notice {
        text: format!("You are now connected to database \"{}\".", db),
    }]
}

/// Static help shown by `\?`.
const HELP_TEXT: &str = "General
  \\q                     quit the console session
  \\?                     show this help

Informational
  \\l                     list databases available in this dump
  \\d[S+]  [NAME]         describe table, view, sequence, or index
  \\dt     [PATTERN]      list tables
  \\dv     [PATTERN]      list views
  \\di     [PATTERN]      list indexes
  \\dn                    list schemas
  \\df     [PATTERN]      list functions

Connection
  \\c [DBNAME]            connect to another database of this dump

Formatting
  \\x                     toggle expanded output
  \\timing [on|off]       toggle timing of commands

SQL statements must end with a semicolon (;).";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_meta_simple() {
        assert_eq!(parse_meta("\\l"), MetaCommand::ListDatabases);
        assert_eq!(parse_meta("\\list"), MetaCommand::ListDatabases);
        assert_eq!(parse_meta("\\dn"), MetaCommand::ListSchemas);
        assert_eq!(parse_meta("\\x"), MetaCommand::ToggleExpanded);
        assert_eq!(parse_meta("\\q"), MetaCommand::Quit);
        assert_eq!(parse_meta("\\?"), MetaCommand::Help);
    }

    #[test]
    fn test_parse_meta_with_arg() {
        assert_eq!(
            parse_meta("\\dt public.*"),
            MetaCommand::ListTables(Some("public.*".to_string()))
        );
        assert_eq!(parse_meta("\\dt"), MetaCommand::ListTables(None));
        assert_eq!(
            parse_meta("\\d products"),
            MetaCommand::Describe(Some("products".to_string()))
        );
        assert_eq!(parse_meta("\\d"), MetaCommand::Describe(None));
        assert_eq!(
            parse_meta("\\c hrdb"),
            MetaCommand::Connect(Some("hrdb".to_string()))
        );
        assert_eq!(parse_meta("\\c"), MetaCommand::Connect(None));
        assert_eq!(
            parse_meta("\\dv myview"),
            MetaCommand::ListViews(Some("myview".to_string()))
        );
        assert_eq!(
            parse_meta("\\di idx"),
            MetaCommand::ListIndexes(Some("idx".to_string()))
        );
        assert_eq!(
            parse_meta("\\df fn"),
            MetaCommand::ListFunctions(Some("fn".to_string()))
        );
    }

    #[test]
    fn test_parse_meta_timing() {
        assert_eq!(parse_meta("\\timing"), MetaCommand::ToggleTiming(None));
        assert_eq!(
            parse_meta("\\timing on"),
            MetaCommand::ToggleTiming(Some(true))
        );
        assert_eq!(
            parse_meta("\\timing off"),
            MetaCommand::ToggleTiming(Some(false))
        );
        assert_eq!(
            parse_meta("\\timing garbage"),
            MetaCommand::ToggleTiming(None)
        );
    }

    #[test]
    fn test_parse_meta_unknown() {
        assert_eq!(
            parse_meta("\\zzz"),
            MetaCommand::Unknown("\\zzz".to_string())
        );
    }

    #[test]
    fn test_pattern_to_like() {
        assert_eq!(pattern_to_like("foo*"), "foo%");
        assert_eq!(pattern_to_like("b?r"), "b_r");
        assert_eq!(pattern_to_like("a_b"), "a\\_b");
        assert_eq!(pattern_to_like("50%"), "50\\%");
        assert_eq!(pattern_to_like("a\\b"), "a\\\\b");
        assert_eq!(pattern_to_like("plain"), "plain");
    }
}
