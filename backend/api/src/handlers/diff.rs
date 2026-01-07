//! Dump diff comparison handlers

use axum::{
    extract::{Path, Query, State},
    Json,
};
use db_viewer_core::diff::{compare_schemas, SchemaDiff};
use db_viewer_core::domain::ForeignKey;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::ApiError;
use crate::state::AppState;

/// Query parameters for diff comparison
#[derive(Debug, Deserialize)]
pub struct DiffQuery {
    /// Database name within the dump (for multi-database dumps)
    #[serde(default)]
    pub database: Option<String>,
}

/// Response for schema diff comparison
#[derive(Debug, Serialize)]
pub struct SchemaDiffResponse {
    /// Base dump ID
    pub base_dump_id: Uuid,
    /// Compare dump ID
    pub compare_dump_id: Uuid,
    /// Database name compared
    pub database_name: String,
    /// The schema diff result
    #[serde(flatten)]
    pub diff: SchemaDiff,
}

/// Compare schemas between two dumps
///
/// GET /api/dumps/:base_id/compare/:compare_id
///
/// Compare the schema of two dumps to see what has changed.
/// Returns tables/columns added, removed, or modified.
pub async fn compare_dumps(
    State(state): State<AppState>,
    Path((base_id, compare_id)): Path<(Uuid, Uuid)>,
    Query(query): Query<DiffQuery>,
) -> Result<Json<SchemaDiffResponse>, ApiError> {
    // Get both dumps from metadata DB
    let base_dump = get_dump_record(&state.db_pool, base_id).await?;
    let compare_dump = get_dump_record(&state.db_pool, compare_id).await?;

    // Ensure both dumps are analyzed (READY status means analyzed)
    if base_dump.status != "READY" {
        return Err(ApiError::BadRequest(format!(
            "Base dump {} is not ready (status: {})",
            base_id, base_dump.status
        )));
    }
    if compare_dump.status != "READY" {
        return Err(ApiError::BadRequest(format!(
            "Compare dump {} is not ready (status: {})",
            compare_id, compare_dump.status
        )));
    }

    // Determine database name - use sandbox_db_name or query parameter
    let db_name = query
        .database
        .or_else(|| base_dump.sandbox_db_name.clone())
        .unwrap_or_else(|| "postgres".to_string());

    // For single-database dumps, use the sandbox_db_name directly
    // For multi-database dumps (pg_dumpall), look up in dump_databases table
    let base_sandbox_db = if let Some(ref sandbox_name) = base_dump.sandbox_db_name {
        sandbox_name.clone()
    } else {
        get_database_record(&state.db_pool, base_id, &db_name)
            .await?
            .sandbox_db_name
    };

    let compare_sandbox_db = if let Some(ref sandbox_name) = compare_dump.sandbox_db_name {
        sandbox_name.clone()
    } else {
        get_database_record(&state.db_pool, compare_id, &db_name)
            .await?
            .sandbox_db_name
    };

    // Get schema info from both sandbox databases
    let base_schema = load_schema_graph(&state.config, &base_sandbox_db).await?;
    let compare_schema = load_schema_graph(&state.config, &compare_sandbox_db).await?;

    // Compare schemas
    let diff = compare_schemas(&base_schema, &compare_schema);

    Ok(Json(SchemaDiffResponse {
        base_dump_id: base_id,
        compare_dump_id: compare_id,
        database_name: db_name,
        diff,
    }))
}

/// Internal dump record for validation
#[derive(Debug, sqlx::FromRow)]
struct DumpRecord {
    status: String,
    sandbox_db_name: Option<String>,
}

/// Get dump record from metadata DB
async fn get_dump_record(pool: &PgPool, dump_id: Uuid) -> Result<DumpRecord, ApiError> {
    let record: Option<DumpRecord> = sqlx::query_as(
        r#"
        SELECT status, sandbox_db_name
        FROM dumps
        WHERE id = $1
        "#,
    )
    .bind(dump_id)
    .fetch_optional(pool)
    .await?;

    record.ok_or_else(|| ApiError::NotFound(format!("Dump {} not found", dump_id)))
}

/// Database record for sandbox connection
#[derive(Debug, sqlx::FromRow)]
struct DatabaseRecord {
    sandbox_db_name: String,
}

/// Get database record from metadata DB
async fn get_database_record(
    pool: &PgPool,
    dump_id: Uuid,
    db_name: &str,
) -> Result<DatabaseRecord, ApiError> {
    let record: Option<DatabaseRecord> = sqlx::query_as(
        r#"
        SELECT sandbox_db_name
        FROM dump_databases
        WHERE dump_id = $1 AND database_name = $2
        "#,
    )
    .bind(dump_id)
    .bind(db_name)
    .fetch_optional(pool)
    .await?;

    record.ok_or_else(|| {
        ApiError::NotFound(format!(
            "Database {} not found in dump {}",
            db_name, dump_id
        ))
    })
}

/// Load schema graph from a sandbox database
async fn load_schema_graph(
    config: &crate::config::AppConfig,
    sandbox_db_name: &str,
) -> Result<db_viewer_core::domain::SchemaGraph, ApiError> {
    use db_viewer_core::domain::{ColumnInfo, SchemaGraph, TableInfo};

    // Connect to sandbox database
    let sandbox_url = format!(
        "postgres://{}:{}@{}:{}/{}",
        config.sandbox_user,
        config.sandbox_password.as_deref().unwrap_or("postgres"),
        config.sandbox_host,
        config.sandbox_port,
        sandbox_db_name
    );

    let sandbox_pool = sqlx::PgPool::connect(&sandbox_url).await?;

    // Get tables with row counts
    let tables: Vec<(String, String, i64)> = sqlx::query_as(
        r#"
        SELECT 
            schemaname::text,
            relname::text,
            COALESCE(n_live_tup, 0)::bigint as row_count
        FROM pg_stat_user_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY schemaname, relname
        "#,
    )
    .fetch_all(&sandbox_pool)
    .await?;

    let mut table_infos = Vec::new();

    for (schema_name, table_name, row_count) in tables {
        // Get columns for this table
        let columns: Vec<(String, String, bool, bool, Option<String>)> = sqlx::query_as(
            r#"
            SELECT 
                c.column_name::text,
                c.data_type::text,
                c.is_nullable = 'YES' as is_nullable,
                COALESCE(
                    EXISTS (
                        SELECT 1 FROM information_schema.table_constraints tc
                        JOIN information_schema.key_column_usage kcu 
                            ON tc.constraint_name = kcu.constraint_name
                        WHERE tc.constraint_type = 'PRIMARY KEY'
                            AND tc.table_schema = c.table_schema
                            AND tc.table_name = c.table_name
                            AND kcu.column_name = c.column_name
                    ),
                    false
                ) as is_pk,
                c.column_default::text
            FROM information_schema.columns c
            WHERE c.table_schema = $1 AND c.table_name = $2
            ORDER BY c.ordinal_position
            "#,
        )
        .bind(&schema_name)
        .bind(&table_name)
        .fetch_all(&sandbox_pool)
        .await?;

        let column_infos: Vec<ColumnInfo> = columns
            .into_iter()
            .map(
                |(name, data_type, is_nullable, is_pk, default_value)| ColumnInfo {
                    name,
                    data_type,
                    is_nullable,
                    is_primary_key: is_pk,
                    default_value,
                },
            )
            .collect();

        table_infos.push(TableInfo {
            schema_name,
            table_name,
            estimated_row_count: row_count,
            columns: column_infos,
        });
    }

    // Get foreign keys
    let fk_rows: Vec<(
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    )> = sqlx::query_as(
        r#"
        SELECT 
            tc.constraint_name::text,
            tc.table_schema::text as source_schema,
            tc.table_name::text as source_table,
            kcu.column_name::text as source_column,
            ccu.table_schema::text as target_schema,
            ccu.table_name::text as target_table,
            ccu.column_name::text as target_column,
            rc.update_rule::text,
            rc.delete_rule::text
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu 
            ON tc.constraint_name = kcu.constraint_name 
            AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu 
            ON tc.constraint_name = ccu.constraint_name
        JOIN information_schema.referential_constraints rc 
            ON tc.constraint_name = rc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
        "#,
    )
    .fetch_all(&sandbox_pool)
    .await?;

    let foreign_keys: Vec<ForeignKey> = fk_rows
        .into_iter()
        .map(
            |(
                constraint_name,
                source_schema,
                source_table,
                source_column,
                target_schema,
                target_table,
                target_column,
                on_update,
                on_delete,
            )| {
                ForeignKey {
                    constraint_name,
                    source_schema,
                    source_table,
                    source_columns: vec![source_column],
                    target_schema,
                    target_table,
                    target_columns: vec![target_column],
                    on_update: parse_fk_action(&on_update),
                    on_delete: parse_fk_action(&on_delete),
                }
            },
        )
        .collect();

    Ok(SchemaGraph {
        tables: table_infos,
        foreign_keys,
    })
}

/// Parse FK action string to FkAction enum
fn parse_fk_action(s: &str) -> db_viewer_core::domain::FkAction {
    use db_viewer_core::domain::FkAction;
    match s.to_uppercase().as_str() {
        "CASCADE" => FkAction::Cascade,
        "RESTRICT" => FkAction::Restrict,
        "SET NULL" => FkAction::SetNull,
        "SET DEFAULT" => FkAction::SetDefault,
        _ => FkAction::NoAction,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_diff_query_defaults() {
        let query: DiffQuery = serde_json::from_str("{}").unwrap();
        assert!(query.database.is_none());
    }
}
