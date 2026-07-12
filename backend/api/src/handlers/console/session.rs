//! Console session management.
//!
//! A console session owns a dedicated, persistent [`PgConnection`] to a sandbox
//! database so that `SET`, temporary tables and transactions survive across
//! individual console inputs (unlike the stateless `/query` endpoint).
//!
//! ## Locking discipline
//!
//! [`SessionManager`] guards its internal map with a synchronous
//! [`std::sync::Mutex`]. That lock is **never held across an `.await`**: every
//! method completes synchronously, cloning out the `Arc`s the caller needs.
//! The per-session [`tokio::sync::Mutex`] is the async lock that is actually
//! held while a command runs; the manager only ever `try_lock`s it (to test
//! liveness for eviction / sweeping), never `.await`s on it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::postgres::PgConnection;
use sqlx::Connection;
use uuid::Uuid;

use crate::config::AppConfig;
use crate::error::{ApiError, ApiResult};
use crate::handlers::sandbox::build_sandbox_url;

/// Hard cap on concurrent console sessions across all dumps.
pub const MAX_SESSIONS_TOTAL: usize = 32;
/// Cap on concurrent console sessions for a single dump.
pub const MAX_SESSIONS_PER_DUMP: usize = 4;
/// Idle time-to-live before a session is swept (seconds).
pub const IDLE_TTL_SECS: u64 = 900;
/// Interval between idle sweeps (seconds).
pub const SWEEP_INTERVAL_SECS: u64 = 60;
/// Statement timeout applied to each session connection (milliseconds).
pub const STATEMENT_TIMEOUT_MS: i64 = 30_000;
/// Maximum number of result rows returned per query.
pub const MAX_ROWS: i64 = 500;

/// A live console session bound to one sandbox database.
pub struct ConsoleSession {
    /// Persistent connection. Swapped via [`std::mem::replace`] on `\c`.
    pub conn: PgConnection,
    /// The dump this session belongs to.
    pub dump_id: Uuid,
    /// The actual sandbox database name currently connected to.
    pub sandbox_db: String,
    /// The user-friendly database name (used for the prompt).
    pub database: String,
    /// `\x` expanded display toggle.
    pub expanded: bool,
    /// `\timing` toggle.
    pub timing: bool,
}

/// Internal map entry pairing a session with bookkeeping.
struct SessionEntry {
    dump_id: Uuid,
    last_used: Arc<AtomicU64>,
    session: Arc<tokio::sync::Mutex<ConsoleSession>>,
}

/// Thread-safe registry of active console sessions.
#[derive(Default)]
pub struct SessionManager {
    inner: Mutex<HashMap<Uuid, SessionEntry>>,
}

/// Current wall-clock time in whole seconds since the Unix epoch.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Pure expiry predicate: has `last_used` fallen outside the TTL window?
fn is_expired(now: u64, last_used: u64, ttl: u64) -> bool {
    now.saturating_sub(last_used) > ttl
}

/// Evict one least-recently-used, currently-unlocked entry.
///
/// `dump_filter` restricts candidates to a single dump when `Some`. Returns
/// `true` if an entry was removed.
fn evict_lru(inner: &mut HashMap<Uuid, SessionEntry>, dump_filter: Option<Uuid>) -> bool {
    let victim = inner
        .iter()
        .filter(|(_, e)| dump_filter.is_none_or(|d| e.dump_id == d))
        .filter(|(_, e)| e.session.try_lock().is_ok())
        .min_by_key(|(_, e)| e.last_used.load(Ordering::Relaxed))
        .map(|(id, _)| *id);
    if let Some(id) = victim {
        inner.remove(&id);
        true
    } else {
        false
    }
}

impl SessionManager {
    /// Insert a new session, enforcing per-dump and total caps via LRU eviction.
    pub fn insert(&self, session: ConsoleSession) -> Result<Uuid, ApiError> {
        let dump_id = session.dump_id;
        let mut inner = self.inner.lock().unwrap();

        // Per-dump cap.
        let per_dump = inner.values().filter(|e| e.dump_id == dump_id).count();
        if per_dump >= MAX_SESSIONS_PER_DUMP && !evict_lru(&mut inner, Some(dump_id)) {
            return Err(ApiError::Conflict(
                "Too many active console sessions".to_string(),
            ));
        }

        // Total cap.
        if inner.len() >= MAX_SESSIONS_TOTAL && !evict_lru(&mut inner, None) {
            return Err(ApiError::Conflict(
                "Too many active console sessions".to_string(),
            ));
        }

        let id = Uuid::new_v4();
        inner.insert(
            id,
            SessionEntry {
                dump_id,
                last_used: Arc::new(AtomicU64::new(now_secs())),
                session: Arc::new(tokio::sync::Mutex::new(session)),
            },
        );
        Ok(id)
    }

    /// Fetch the session handle and its last-used clock, if present.
    pub fn get(
        &self,
        id: Uuid,
    ) -> Option<(Arc<tokio::sync::Mutex<ConsoleSession>>, Arc<AtomicU64>)> {
        let inner = self.inner.lock().unwrap();
        inner
            .get(&id)
            .map(|e| (e.session.clone(), e.last_used.clone()))
    }

    /// Remove a session, returning its handle so the caller can close it.
    pub fn remove(&self, id: Uuid) -> Option<Arc<tokio::sync::Mutex<ConsoleSession>>> {
        let mut inner = self.inner.lock().unwrap();
        inner.remove(&id).map(|e| e.session)
    }

    /// Remove and return all idle, currently-unlocked sessions.
    pub fn sweep_idle(&self) -> Vec<Arc<tokio::sync::Mutex<ConsoleSession>>> {
        let now = now_secs();
        let mut inner = self.inner.lock().unwrap();
        let expired: Vec<Uuid> = inner
            .iter()
            .filter(|(_, e)| is_expired(now, e.last_used.load(Ordering::Relaxed), IDLE_TTL_SECS))
            .filter(|(_, e)| e.session.try_lock().is_ok())
            .map(|(id, _)| *id)
            .collect();
        expired
            .into_iter()
            .filter_map(|id| inner.remove(&id).map(|e| e.session))
            .collect()
    }
}

/// Open a fresh session connection to a sandbox database and set its timeout.
///
/// Used both when creating a session and when switching databases via `\c`.
pub async fn open_session_conn(config: &AppConfig, sandbox_db: &str) -> ApiResult<PgConnection> {
    let url = build_sandbox_url(config, sandbox_db);
    let mut conn = PgConnection::connect(&url)
        .await
        .map_err(|e| ApiError::Internal(format!("Failed to connect to sandbox: {}", e)))?;
    sqlx::query(&format!("SET statement_timeout = {}", STATEMENT_TIMEOUT_MS))
        .execute(&mut conn)
        .await
        .map_err(|e| ApiError::Internal(format!("Failed to set statement timeout: {}", e)))?;
    Ok(conn)
}

/// Best-effort close of a session's connection.
///
/// If we hold the only remaining reference we close the connection gracefully;
/// otherwise it is left to `Drop`.
pub async fn close_session(session: Arc<tokio::sync::Mutex<ConsoleSession>>) {
    if let Ok(mutex) = Arc::try_unwrap(session) {
        let cs = mutex.into_inner();
        let _ = cs.conn.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_expired() {
        assert!(!is_expired(1000, 900, 900)); // 100s idle < 900 TTL
        assert!(!is_expired(1000, 100, 900)); // exactly 900 idle, not > TTL
        assert!(is_expired(1000, 99, 900)); // 901s idle > 900 TTL
    }

    #[test]
    fn test_is_expired_saturating() {
        // last_used in the "future" must not underflow into expiry.
        assert!(!is_expired(100, 200, 900));
    }
}
