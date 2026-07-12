//! Interactive psql-like console over a persistent sandbox connection.
//!
//! Unlike the stateless `/query` endpoint, a console *session* holds a dedicated
//! connection so `SET`, temporary tables and transactions persist between
//! inputs. Meta-commands (`\dt`, `\d`, `\c`, ...) are implemented as catalog
//! queries. See [`session`] for the session registry and locking discipline.

pub mod meta;
pub mod session;
pub mod sql;

use std::sync::atomic::Ordering;
use std::time::Instant;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::handlers::sandbox::{extract_original_db_name, resolve_sandbox_db};
use crate::state::AppState;
use session::ConsoleSession;

/// A single rendered output block. The client draws these psql-style.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    /// Tabular result. `rows` cells are `None` for SQL NULL.
    Table {
        columns: Vec<String>,
        rows: Vec<Vec<Option<String>>>,
        footer: Option<String>,
        expanded: bool,
    },
    /// Plain text line (command tags, titles, index/FK listings, timing).
    Text { text: String },
    /// Error line (rendered red client-side).
    Error { text: String },
    /// Notice line (e.g. `\c` connection messages).
    Notice { text: String },
}

/// Request body for session creation. `{}` is accepted.
#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    #[serde(default)]
    pub database: Option<String>,
}

/// Response for session creation.
#[derive(Debug, Serialize)]
pub struct CreateSessionResponse {
    pub session_id: String,
    pub database: String,
    pub prompt: String,
}

/// Request body for a single console input.
#[derive(Debug, Deserialize)]
pub struct ExecuteRequest {
    pub input: String,
}

/// Response for a single console input.
#[derive(Debug, Serialize)]
pub struct ExecuteResponse {
    pub blocks: Vec<Block>,
    pub database: String,
    pub prompt: String,
    pub expanded: bool,
    pub timing: bool,
    pub session_ended: bool,
    pub execution_ms: u128,
}

/// Build the psql-style prompt for a database name.
fn prompt_for(db: &str) -> String {
    format!("{}=#", db)
}

/// `POST /api/dumps/:id/console` — create a console session.
pub async fn create_session(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<CreateSessionRequest>,
) -> ApiResult<Json<CreateSessionResponse>> {
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
    let conn = session::open_session_conn(&state.config, &sandbox_db).await?;

    let database = req
        .database
        .clone()
        .unwrap_or_else(|| extract_original_db_name(&sandbox_db));

    let cs = ConsoleSession {
        conn,
        dump_id: id,
        sandbox_db,
        database: database.clone(),
        expanded: false,
        timing: false,
    };
    let session_id = state.console_sessions.insert(cs)?;

    Ok(Json(CreateSessionResponse {
        session_id: session_id.to_string(),
        prompt: prompt_for(&database),
        database,
    }))
}

/// `POST /api/console/:session_id` — run one complete input.
pub async fn execute(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    Json(req): Json<ExecuteRequest>,
) -> ApiResult<Json<ExecuteResponse>> {
    let input = req.input.trim();
    if input.is_empty() {
        return Err(ApiError::BadRequest("Empty input".to_string()));
    }

    let (session_arc, last_used) = state
        .console_sessions
        .get(session_id)
        .ok_or_else(|| ApiError::NotFound("Console session not found or expired".to_string()))?;

    // `try_lock` so a concurrent in-flight command surfaces as 409 rather than
    // queueing behind it.
    let mut guard = session_arc
        .try_lock()
        .map_err(|_| ApiError::Conflict("Console session is busy".to_string()))?;

    let start = Instant::now();
    let (mut blocks, ended) = if input.starts_with('\\') {
        meta::run_meta(meta::parse_meta(input), &mut guard, &state).await
    } else {
        let mut b = sql::run_sql(&mut guard.conn, input).await;
        for blk in &mut b {
            if let Block::Table { expanded, .. } = blk {
                *expanded = guard.expanded;
            }
        }
        (b, false)
    };
    let elapsed = start.elapsed();
    let execution_ms = elapsed.as_millis();

    if guard.timing {
        blocks.push(Block::Text {
            text: format!("Time: {:.3} ms", elapsed.as_secs_f64() * 1000.0),
        });
    }

    let database = guard.database.clone();
    let expanded = guard.expanded;
    let timing = guard.timing;
    last_used.store(session::now_secs(), Ordering::Relaxed);
    drop(guard);

    if ended {
        if let Some(s) = state.console_sessions.remove(session_id) {
            session::close_session(s).await;
        }
    }

    Ok(Json(ExecuteResponse {
        blocks,
        prompt: prompt_for(&database),
        database,
        expanded,
        timing,
        session_ended: ended,
        execution_ms,
    }))
}

/// `DELETE /api/console/:session_id` — close a session (idempotent).
pub async fn close_session(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
) -> StatusCode {
    if let Some(s) = state.console_sessions.remove(session_id) {
        session::close_session(s).await;
    }
    StatusCode::NO_CONTENT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prompt_for() {
        assert_eq!(prompt_for("salesdb"), "salesdb=#");
    }

    #[test]
    fn test_create_request_default() {
        let req: CreateSessionRequest = serde_json::from_str("{}").unwrap();
        assert!(req.database.is_none());
        let req: CreateSessionRequest = serde_json::from_str(r#"{"database":"hrdb"}"#).unwrap();
        assert_eq!(req.database.as_deref(), Some("hrdb"));
    }

    #[test]
    fn test_block_serialization() {
        let b = Block::Table {
            columns: vec!["id".into()],
            rows: vec![vec![Some("1".into())], vec![None]],
            footer: Some("(2 rows)".into()),
            expanded: false,
        };
        let json = serde_json::to_string(&b).unwrap();
        assert!(json.contains("\"type\":\"table\""));
        assert!(json.contains("null"));

        let e = Block::Error {
            text: "boom".into(),
        };
        assert!(serde_json::to_string(&e)
            .unwrap()
            .contains("\"type\":\"error\""));
    }
}
