//! SQL console handler.
//!
//! Executes an arbitrary single SQL statement against a restored sandbox
//! database. All statement kinds are allowed (SELECT / DML / DDL) because the
//! sandbox is disposable and can be re-restored. Guardrails are limited to a
//! statement timeout, a row cap, and accurate error reporting.
//!
//! Known limitations (kept intentionally simple for v1):
//! - Only a single statement per request. sqlx's extended protocol naturally
//!   rejects multiple statements, which surfaces as a clear 400.
//! - Result rows are returned as `jsonb`, so duplicate output column names get
//!   collapsed (use column aliases) and `EXPLAIN (FORMAT JSON)` is not
//!   supported.
//! - Data-modifying CTEs (e.g. `WITH x AS (INSERT ...)`) cannot be wrapped and
//!   will fail.

use std::time::Instant;

use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::{Column, Connection, Executor, Row};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::handlers::sandbox::{build_sandbox_url, resolve_sandbox_db};
use crate::state::AppState;

/// Maximum number of rows that may be requested.
const MAX_ROWS_CAP: i64 = 2000;
/// Default number of rows returned when `max_rows` is not specified.
const DEFAULT_MAX_ROWS: i64 = 500;
/// Statement timeout applied to every console query (milliseconds).
const STATEMENT_TIMEOUT_MS: i64 = 30_000;

/// Request body for the SQL console.
#[derive(Debug, Deserialize)]
pub struct QueryRequest {
    /// The SQL statement to execute.
    pub sql: String,
    /// Optional database name for pg_dumpall dumps with multiple databases.
    pub database: Option<String>,
    /// Optional cap on the number of rows returned (defaults to 500, max 2000).
    pub max_rows: Option<i64>,
}

/// Response for the SQL console.
#[derive(Debug, Serialize)]
pub struct QueryResponse {
    /// `"rows"` for result sets, `"command"` for statements without a result set.
    pub kind: String,
    /// Ordered column names (authoritative order for rendering).
    pub columns: Vec<String>,
    /// Result rows as JSON objects.
    pub rows: Vec<serde_json::Value>,
    /// Number of rows returned.
    pub row_count: usize,
    /// True when the result was truncated to `max_rows`.
    pub truncated: bool,
    /// Number of rows affected for command-style statements.
    pub rows_affected: Option<i64>,
    /// Server-side execution time in milliseconds.
    pub execution_ms: u128,
}

/// Return the first meaningful SQL keyword, uppercased, skipping leading
/// whitespace and `--` line / `/* */` block comments.
pub(crate) fn first_keyword(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut i = 0;
    let n = bytes.len();
    loop {
        // Skip whitespace
        while i < n && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        // Skip line comments
        if i + 1 < n && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            i += 2;
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // Skip block comments
        if i + 1 < n && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < n && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2; // consume closing */
            continue;
        }
        break;
    }
    let start = i;
    while i < n && (bytes[i].is_ascii_alphabetic() || bytes[i] == b'_') {
        i += 1;
    }
    sql[start..i].to_ascii_uppercase()
}

/// Map a sqlx error from statement execution into a 400 with the postgres message.
fn map_sql_error(e: sqlx::Error) -> ApiError {
    match &e {
        sqlx::Error::Database(db) => ApiError::BadRequest(format!("SQL error: {}", db.message())),
        other => ApiError::BadRequest(format!("SQL error: {}", other)),
    }
}

/// Execute a single SQL statement against a dump's sandbox database.
pub async fn execute_query(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<QueryRequest>,
) -> ApiResult<Json<QueryResponse>> {
    // Normalize the statement: trim and drop a single trailing semicolon.
    let sql = req.sql.trim().trim_end_matches(';').trim();
    if sql.is_empty() {
        return Err(ApiError::BadRequest("SQL statement is empty".to_string()));
    }

    let max_rows = req
        .max_rows
        .unwrap_or(DEFAULT_MAX_ROWS)
        .clamp(1, MAX_ROWS_CAP);

    // Ensure the dump is READY before touching the sandbox.
    let status_row = sqlx::query("SELECT status FROM dumps WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db_pool)
        .await?;
    let status_row =
        status_row.ok_or_else(|| ApiError::NotFound(format!("Dump {} not found", id)))?;
    let status: String = status_row.get("status");
    if status != "READY" {
        return Err(ApiError::BadRequest(format!(
            "Dump is not ready for queries (status: {})",
            status
        )));
    }

    let sandbox_db = resolve_sandbox_db(&state.db_pool, id, req.database.as_deref()).await?;
    let sandbox_url = build_sandbox_url(&state.config, &sandbox_db);

    // A single dedicated connection is required so that `SET` applies to the
    // same session as the query (a pooled connection could differ).
    let mut conn = sqlx::postgres::PgConnection::connect(&sandbox_url)
        .await
        .map_err(|e| ApiError::Internal(format!("Failed to connect to sandbox: {}", e)))?;

    // Guard long-running queries.
    sqlx::query(&format!("SET statement_timeout = {}", STATEMENT_TIMEOUT_MS))
        .execute(&mut conn)
        .await
        .map_err(|e| ApiError::Internal(format!("Failed to set statement timeout: {}", e)))?;

    let start = Instant::now();

    // Inspect the statement metadata to classify it.
    let describe = (&mut conn).describe(sql).await.map_err(map_sql_error)?;
    let described_columns: Vec<String> = describe
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();

    let keyword = first_keyword(sql);
    // EXPLAIN / SHOW cannot be wrapped in a CTE; fetch them as plain text rows.
    let is_text = matches!(keyword.as_str(), "EXPLAIN" | "SHOW");

    let response = if !is_text && described_columns.is_empty() {
        // Command path: DDL or DML without a result set.
        let result = sqlx::query(sql)
            .execute(&mut conn)
            .await
            .map_err(map_sql_error)?;
        QueryResponse {
            kind: "command".to_string(),
            columns: Vec::new(),
            rows: Vec::new(),
            row_count: 0,
            truncated: false,
            rows_affected: Some(result.rows_affected() as i64),
            execution_ms: start.elapsed().as_millis(),
        }
    } else if is_text {
        // Text path: EXPLAIN / SHOW. Stringify every column.
        let raw_rows = sqlx::query(sql)
            .fetch_all(&mut conn)
            .await
            .map_err(map_sql_error)?;
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
        let rows: Vec<serde_json::Value> = raw_rows
            .iter()
            .map(|row| {
                let mut obj = serde_json::Map::new();
                for (idx, col) in columns.iter().enumerate() {
                    let val: Option<String> = row.try_get(idx).ok().flatten();
                    obj.insert(
                        col.clone(),
                        val.map(serde_json::Value::String)
                            .unwrap_or(serde_json::Value::Null),
                    );
                }
                serde_json::Value::Object(obj)
            })
            .collect();
        QueryResponse {
            kind: "rows".to_string(),
            row_count: rows.len(),
            columns,
            rows,
            truncated: false,
            rows_affected: None,
            execution_ms: start.elapsed().as_millis(),
        }
    } else {
        // Rows path: SELECT / WITH / VALUES / DML with RETURNING.
        // Wrap in a CTE so a uniform jsonb projection and LIMIT can be applied.
        let wrapped = format!(
            "WITH q AS ({}) SELECT to_jsonb(q.*) AS row_data FROM q LIMIT {}",
            sql,
            max_rows + 1
        );
        let mut rows: Vec<serde_json::Value> = sqlx::query(&wrapped)
            .fetch_all(&mut conn)
            .await
            .map_err(map_sql_error)?
            .iter()
            .map(|row| row.get::<serde_json::Value, _>("row_data"))
            .collect();

        let truncated = rows.len() as i64 > max_rows;
        if truncated {
            rows.truncate(max_rows as usize);
        }

        QueryResponse {
            kind: "rows".to_string(),
            columns: described_columns,
            row_count: rows.len(),
            rows,
            truncated,
            rows_affected: None,
            execution_ms: start.elapsed().as_millis(),
        }
    };

    Ok(Json(response))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_first_keyword_plain() {
        assert_eq!(first_keyword("SELECT 1"), "SELECT");
        assert_eq!(first_keyword("  select * from t"), "SELECT");
    }

    #[test]
    fn test_first_keyword_line_comment() {
        assert_eq!(first_keyword("-- a comment\nSELECT 1"), "SELECT");
    }

    #[test]
    fn test_first_keyword_block_comment() {
        assert_eq!(first_keyword("/* hello */ EXPLAIN SELECT 1"), "EXPLAIN");
        assert_eq!(first_keyword("/* multi\nline */\n  show all"), "SHOW");
    }

    #[test]
    fn test_first_keyword_mixed_whitespace_and_comments() {
        assert_eq!(
            first_keyword("\n\t-- one\n  /* two */  With x AS (select 1) select * from x"),
            "WITH"
        );
    }

    #[test]
    fn test_first_keyword_empty() {
        assert_eq!(first_keyword("   "), "");
        assert_eq!(first_keyword("-- only a comment"), "");
    }

    #[test]
    fn test_deserialize_request_minimal() {
        let req: QueryRequest = serde_json::from_str(r#"{"sql":"SELECT 1"}"#).unwrap();
        assert_eq!(req.sql, "SELECT 1");
        assert!(req.database.is_none());
        assert!(req.max_rows.is_none());
    }

    #[test]
    fn test_deserialize_request_full() {
        let req: QueryRequest =
            serde_json::from_str(r#"{"sql":"SELECT 1","database":"salesdb","max_rows":100}"#)
                .unwrap();
        assert_eq!(req.database.as_deref(), Some("salesdb"));
        assert_eq!(req.max_rows, Some(100));
    }

    #[test]
    fn test_trailing_semicolon_stripped() {
        let sql = "SELECT 1;".trim().trim_end_matches(';').trim();
        assert_eq!(sql, "SELECT 1");
    }
}
