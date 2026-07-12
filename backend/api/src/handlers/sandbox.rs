//! Shared helpers for resolving and connecting to sandbox databases.
//!
//! These helpers were extracted from `schema.rs` so that multiple handlers
//! (schema, table data, SQL console, ...) can share the same logic for
//! turning a user-friendly database name into the actual sandbox database and
//! building a connection URL.

use sqlx::postgres::PgPool;
use sqlx::Row;
use uuid::Uuid;

use crate::config::AppConfig;
use crate::error::{ApiError, ApiResult};

/// Extract the original database name from a sandbox database name.
///
/// Prefixed format: `sandbox_{uuid_with_underscores}_{original_db_name}` -> `original_db_name`
/// Non-prefixed format: `original_db_name` -> `original_db_name`
pub fn extract_original_db_name(sandbox_name: &str) -> String {
    if sandbox_name.starts_with("sandbox_") {
        // Format: sandbox_{uuid_with_underscores}_{db_name}
        // UUID format: xxxxxxxx_xxxx_xxxx_xxxx_xxxxxxxxxxxx (36 chars with underscores)
        // Total prefix: "sandbox_" (8) + uuid (36) + "_" (1) = 45 chars
        if sandbox_name.len() > 45 && sandbox_name.chars().nth(44) == Some('_') {
            return sandbox_name[45..].to_string();
        }
    }
    sandbox_name.to_string()
}

/// Find sandbox database name for a given user-friendly database name.
///
/// Searches through `sandbox_databases` to find one that matches the original name.
pub fn find_sandbox_db_name(
    sandbox_databases: &Option<Vec<String>>,
    user_db_name: &str,
) -> Option<String> {
    if let Some(dbs) = sandbox_databases {
        let suffix = format!("_{}", user_db_name);
        dbs.iter()
            .find(|db| db.ends_with(&suffix) || *db == user_db_name)
            .cloned()
    } else {
        None
    }
}

/// Resolve the sandbox database name for a dump.
///
/// Looks up `sandbox_db_name` / `sandbox_databases` from the `dumps` table and,
/// given an optional user-friendly database name, returns the actual sandbox
/// database to connect to. When no database is requested, the first available
/// (or primary) database is used.
pub async fn resolve_sandbox_db(
    db_pool: &PgPool,
    dump_id: Uuid,
    requested_db: Option<&str>,
) -> ApiResult<String> {
    let dump_row =
        sqlx::query("SELECT sandbox_db_name, sandbox_databases FROM dumps WHERE id = $1")
            .bind(dump_id)
            .fetch_optional(db_pool)
            .await?;

    let row = dump_row.ok_or_else(|| ApiError::NotFound(format!("Dump {} not found", dump_id)))?;

    let primary_db: Option<String> = row.get("sandbox_db_name");
    let available_dbs: Option<Vec<String>> = row.get("sandbox_databases");

    if let Some(user_db) = requested_db {
        find_sandbox_db_name(&available_dbs, user_db)
            .or_else(|| {
                primary_db.as_ref().and_then(|pdb| {
                    if pdb == user_db || extract_original_db_name(pdb) == *user_db {
                        Some(pdb.clone())
                    } else {
                        None
                    }
                })
            })
            .ok_or_else(|| {
                let friendly_names: Vec<String> = available_dbs
                    .as_ref()
                    .map(|dbs| dbs.iter().map(|d| extract_original_db_name(d)).collect())
                    .unwrap_or_else(|| {
                        primary_db
                            .iter()
                            .map(|p| extract_original_db_name(p))
                            .collect()
                    });
                ApiError::BadRequest(format!(
                    "Database '{}' is not available for this dump. Available: {:?}",
                    user_db, friendly_names
                ))
            })
    } else {
        available_dbs
            .and_then(|dbs| dbs.first().cloned())
            .or(primary_db)
            .ok_or_else(|| ApiError::BadRequest("Dump not restored yet".to_string()))
    }
}

/// Build a PostgreSQL connection URL for a sandbox database.
pub fn build_sandbox_url(config: &AppConfig, db_name: &str) -> String {
    if let Some(ref password) = config.sandbox_password {
        format!(
            "postgres://{}:{}@{}:{}/{}",
            config.sandbox_user, password, config.sandbox_host, config.sandbox_port, db_name
        )
    } else {
        format!(
            "postgres://{}@{}:{}/{}",
            config.sandbox_user, config.sandbox_host, config.sandbox_port, db_name
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_original_db_name_prefixed() {
        let name = "sandbox_abcdef01_2345_6789_abcd_ef0123456789_salesdb";
        assert_eq!(extract_original_db_name(name), "salesdb");
    }

    #[test]
    fn test_extract_original_db_name_non_prefixed() {
        assert_eq!(extract_original_db_name("mydb"), "mydb");
    }

    #[test]
    fn test_find_sandbox_db_name_by_suffix() {
        let dbs = Some(vec![
            "sandbox_abcdef01_2345_6789_abcd_ef0123456789_salesdb".to_string(),
            "sandbox_abcdef01_2345_6789_abcd_ef0123456789_hrdb".to_string(),
        ]);
        assert_eq!(
            find_sandbox_db_name(&dbs, "hrdb"),
            Some("sandbox_abcdef01_2345_6789_abcd_ef0123456789_hrdb".to_string())
        );
    }

    #[test]
    fn test_find_sandbox_db_name_none() {
        let dbs = Some(vec!["sandbox_x_salesdb".to_string()]);
        assert_eq!(find_sandbox_db_name(&dbs, "missing"), None);
        assert_eq!(find_sandbox_db_name(&None, "any"), None);
    }
}
