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

/// Type alias for foreign key query result to reduce type complexity
type FkQueryRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
);

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
    tracing::info!(
        "compare_dumps: base={}, compare={}, query={:?}",
        base_id,
        compare_id,
        query
    );

    // Get both dumps from metadata DB
    let base_dump = get_dump_record(&state.db_pool, base_id).await?;
    let compare_dump = get_dump_record(&state.db_pool, compare_id).await?;

    tracing::info!(
        "base_dump: sandbox_db={:?}, status={}",
        base_dump.sandbox_db_name,
        base_dump.status
    );
    tracing::info!(
        "compare_dump: sandbox_db={:?}, status={}",
        compare_dump.sandbox_db_name,
        compare_dump.status
    );

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

    // Determine which sandbox database to compare
    // For pg_dumpall dumps, each original database is stored with a prefixed name: sandbox_{dump_id}_{original_db_name}
    // If query.database is specified, we need to find the corresponding sandbox database from sandbox_databases array
    // Otherwise, fall back to the dump's sandbox_db_name (for backward compatibility with single-db dumps)

    let base_sandbox_db = if let Some(ref selected_db) = query.database {
        // User selected a specific database - find it in sandbox_databases
        find_sandbox_db_for_original(&base_dump, selected_db)
            .or_else(|| {
                // Fall back to sandbox_db_name if not found (legacy single-database dumps)
                base_dump.sandbox_db_name.clone()
            })
            .ok_or_else(|| {
                ApiError::BadRequest(format!("Database {} not found in base dump", selected_db))
            })?
    } else {
        // No database selected - use the dump's default sandbox_db_name or first from sandbox_databases
        base_dump
            .sandbox_db_name
            .clone()
            .or_else(|| {
                base_dump
                    .sandbox_databases
                    .as_ref()
                    .and_then(|dbs| dbs.first().cloned())
            })
            .ok_or_else(|| {
                ApiError::BadRequest(
                    "Base dump has no sandbox database. Please select a database.".to_string(),
                )
            })?
    };

    let compare_sandbox_db = if let Some(ref selected_db) = query.database {
        // User selected a specific database - find it in sandbox_databases
        find_sandbox_db_for_original(&compare_dump, selected_db)
            .or_else(|| {
                // Fall back to sandbox_db_name if not found
                compare_dump.sandbox_db_name.clone()
            })
            .ok_or_else(|| {
                ApiError::BadRequest(format!(
                    "Database {} not found in compare dump",
                    selected_db
                ))
            })?
    } else {
        // No database selected - use the dump's default sandbox_db_name or first from sandbox_databases
        compare_dump
            .sandbox_db_name
            .clone()
            .or_else(|| {
                compare_dump
                    .sandbox_databases
                    .as_ref()
                    .and_then(|dbs| dbs.first().cloned())
            })
            .ok_or_else(|| {
                ApiError::BadRequest(
                    "Compare dump has no sandbox database. Please select a database.".to_string(),
                )
            })?
    };

    // Database name for response (user-friendly name)
    let db_name = query
        .database
        .clone()
        .or_else(|| base_dump.sandbox_db_name.clone())
        .unwrap_or_else(|| "unknown".to_string());

    tracing::info!(
        "Database selection: selected={:?}, base_sandbox={}, compare_sandbox={}",
        query.database,
        base_sandbox_db,
        compare_sandbox_db
    );

    // Get schema info from both sandbox databases
    tracing::info!("Loading base schema from: {}", base_sandbox_db);
    let base_schema = load_schema_graph(&state.config, &base_sandbox_db).await?;
    tracing::info!(
        "Base schema: {} tables, {} FKs",
        base_schema.tables.len(),
        base_schema.foreign_keys.len()
    );

    tracing::info!("Loading compare schema from: {}", compare_sandbox_db);
    let compare_schema = load_schema_graph(&state.config, &compare_sandbox_db).await?;
    tracing::info!(
        "Compare schema: {} tables, {} FKs",
        compare_schema.tables.len(),
        compare_schema.foreign_keys.len()
    );

    // Compare schemas
    let mut diff = compare_schemas(&base_schema, &compare_schema);
    tracing::info!(
        "Diff result: {} table diffs, {} FK diffs",
        diff.table_diffs.len(),
        diff.fk_diffs.len()
    );

    // Check for data changes in tables that exist in both dumps
    // This detects content changes even when row count is the same
    let base_pool = create_sandbox_pool(&state.config, &base_sandbox_db).await?;
    let compare_pool = create_sandbox_pool(&state.config, &compare_sandbox_db).await?;

    // Build set of tables in both dumps (excluding added/removed)
    let base_tables: std::collections::HashSet<_> = base_schema
        .tables
        .iter()
        .map(|t| (t.schema_name.as_str(), t.table_name.as_str()))
        .collect();
    let compare_tables: std::collections::HashSet<_> = compare_schema
        .tables
        .iter()
        .map(|t| (t.schema_name.as_str(), t.table_name.as_str()))
        .collect();
    let common_tables: Vec<_> = base_tables.intersection(&compare_tables).collect();

    // Calculate data checksums for common tables and detect changes
    let mut tables_with_data_changes: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();

    for (schema, table) in &common_tables {
        match (
            calculate_table_checksum(&base_pool, schema, table).await,
            calculate_table_checksum(&compare_pool, schema, table).await,
        ) {
            (Ok(base_checksum), Ok(compare_checksum)) => {
                if base_checksum != compare_checksum {
                    tracing::info!(
                        "Data change detected in {}.{}: {} vs {}",
                        schema,
                        table,
                        base_checksum.as_deref().unwrap_or("NULL"),
                        compare_checksum.as_deref().unwrap_or("NULL")
                    );
                    tables_with_data_changes.insert((schema.to_string(), table.to_string()));
                }
            }
            (Err(e), _) | (_, Err(e)) => {
                tracing::warn!(
                    "Failed to calculate checksum for {}.{}: {}",
                    schema,
                    table,
                    e
                );
            }
        }
    }

    // Update has_data_change flag for tables already in diff
    for table_diff in &mut diff.table_diffs {
        if tables_with_data_changes.contains(&(
            table_diff.schema_name.clone(),
            table_diff.table_name.clone(),
        )) {
            table_diff.has_data_change = true;
        }
    }

    // Add tables with data-only changes (not in diff yet)
    let tables_in_diff: std::collections::HashSet<_> = diff
        .table_diffs
        .iter()
        .map(|t| (t.schema_name.clone(), t.table_name.clone()))
        .collect();

    for (schema, table) in &tables_with_data_changes {
        if !tables_in_diff.contains(&(schema.clone(), table.clone())) {
            // Find row counts from schema
            let base_row_count = base_schema
                .tables
                .iter()
                .find(|t| &t.schema_name == schema && &t.table_name == table)
                .map(|t| t.estimated_row_count);
            let compare_row_count = compare_schema
                .tables
                .iter()
                .find(|t| &t.schema_name == schema && &t.table_name == table)
                .map(|t| t.estimated_row_count);

            diff.table_diffs.push(db_viewer_core::diff::TableDiff {
                schema_name: schema.clone(),
                table_name: table.clone(),
                change_type: db_viewer_core::diff::ChangeType::Modified,
                base_row_count,
                compare_row_count,
                column_diffs: vec![],
                has_data_change: true,
            });
        }
    }

    tracing::info!(
        "After data check: {} table diffs, {} with data changes",
        diff.table_diffs.len(),
        tables_with_data_changes.len()
    );

    Ok(Json(SchemaDiffResponse {
        base_dump_id: base_id,
        compare_dump_id: compare_id,
        database_name: db_name,
        diff,
    }))
}

/// Calculate a checksum for all data in a table
/// Uses PostgreSQL's md5 function to hash all row data
async fn calculate_table_checksum(
    pool: &sqlx::PgPool,
    schema: &str,
    table: &str,
) -> Result<Option<String>, ApiError> {
    // Hash the first 10000 rows of data to detect changes
    // This is efficient while still detecting most data changes
    let query = format!(
        r#"
        SELECT md5(COALESCE(
            (SELECT string_agg(row_hash, '' ORDER BY row_hash)
             FROM (
                 SELECT md5(t::text) as row_hash
                 FROM "{}"."{}" t
                 LIMIT 10000
             ) sub),
            ''
        )) as checksum
        "#,
        schema, table
    );

    let result: Option<(Option<String>,)> = sqlx::query_as(&query).fetch_optional(pool).await?;

    Ok(result.and_then(|(checksum,)| checksum))
}

/// Internal dump record for validation
#[derive(Debug, sqlx::FromRow)]
struct DumpRecord {
    status: String,
    sandbox_db_name: Option<String>,
    sandbox_databases: Option<Vec<String>>,
}

/// Get dump record from metadata DB
async fn get_dump_record(pool: &PgPool, dump_id: Uuid) -> Result<DumpRecord, ApiError> {
    let record: Option<DumpRecord> = sqlx::query_as(
        r#"
        SELECT status, sandbox_db_name, sandbox_databases
        FROM dumps
        WHERE id = $1
        "#,
    )
    .bind(dump_id)
    .fetch_optional(pool)
    .await?;

    record.ok_or_else(|| ApiError::NotFound(format!("Dump {} not found", dump_id)))
}

/// Find sandbox database name for a given original database name
///
/// For pg_dumpall dumps, sandbox databases are named: sandbox_{dump_id}_{original_db_name}
/// This function looks through the sandbox_databases array to find a match.
fn find_sandbox_db_for_original(dump: &DumpRecord, original_db_name: &str) -> Option<String> {
    if let Some(ref databases) = dump.sandbox_databases {
        // Look for a sandbox database that ends with _{original_db_name}
        // Look for a sandbox database that:
        // 1. Ends with _{original_db_name} (prefixed format: sandbox_{dump_id}_{db_name})
        // 2. OR exactly matches original_db_name (old format: db_name directly)
        let suffix = format!("_{}", original_db_name);
        databases
            .iter()
            .find(|db| db.ends_with(&suffix) || *db == original_db_name)
            .cloned()
    } else {
        None
    }
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
    let fk_rows: Vec<FkQueryRow> = sqlx::query_as(
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

/// Query parameters for table data diff
#[derive(Debug, Deserialize)]
pub struct TableDataDiffQuery {
    /// Maximum number of rows to sample per category
    #[serde(default = "default_sample_limit")]
    pub limit: usize,
    /// Database name within the dump (for multi-database dumps)
    #[serde(default)]
    pub database: Option<String>,
}

fn default_sample_limit() -> usize {
    100
}

/// Single row difference
#[derive(Debug, Serialize)]
pub struct RowDiff {
    /// The primary key value(s) for this row
    pub pk: serde_json::Value,
    /// Type of change
    pub change_type: String,
    /// Column values in base dump (null if added)
    pub base_values: Option<serde_json::Value>,
    /// Column values in compare dump (null if removed)
    pub compare_values: Option<serde_json::Value>,
    /// List of columns that changed (for modified rows)
    pub changed_columns: Vec<String>,
}

/// Response for table data diff
#[derive(Debug, Serialize)]
pub struct TableDataDiffResponse {
    pub base_dump_id: Uuid,
    pub compare_dump_id: Uuid,
    pub schema_name: String,
    pub table_name: String,
    pub primary_key_columns: Vec<String>,
    pub total_added: i64,
    pub total_removed: i64,
    pub total_modified: i64,
    pub rows: Vec<RowDiff>,
    pub truncated: bool,
}

/// Get data diff for a specific table between two dumps
///
/// GET /api/dumps/:base_id/compare/:compare_id/table/:schema/:table
pub async fn compare_table_data(
    State(state): State<AppState>,
    Path((base_id, compare_id, schema, table)): Path<(Uuid, Uuid, String, String)>,
    Query(query): Query<TableDataDiffQuery>,
) -> Result<Json<TableDataDiffResponse>, ApiError> {
    tracing::info!(
        "compare_table_data: base={}, compare={}, table={}.{}",
        base_id,
        compare_id,
        schema,
        table
    );

    // Get both dumps
    let base_dump = get_dump_record(&state.db_pool, base_id).await?;
    let compare_dump = get_dump_record(&state.db_pool, compare_id).await?;

    if base_dump.status != "READY" || compare_dump.status != "READY" {
        return Err(ApiError::BadRequest(
            "Both dumps must be in READY state".to_string(),
        ));
    }

    // Determine which sandbox database to use
    // Same logic as compare_dumps: if query.database is specified, find in sandbox_databases
    let base_sandbox_db = if let Some(ref selected_db) = query.database {
        find_sandbox_db_for_original(&base_dump, selected_db)
            .or_else(|| base_dump.sandbox_db_name.clone())
            .ok_or_else(|| {
                ApiError::BadRequest(format!("Database {} not found in base dump", selected_db))
            })?
    } else {
        base_dump
            .sandbox_db_name
            .clone()
            .or_else(|| {
                base_dump
                    .sandbox_databases
                    .as_ref()
                    .and_then(|dbs| dbs.first().cloned())
            })
            .ok_or_else(|| ApiError::BadRequest("Base dump has no sandbox database".to_string()))?
    };

    let compare_sandbox_db = if let Some(ref selected_db) = query.database {
        find_sandbox_db_for_original(&compare_dump, selected_db)
            .or_else(|| compare_dump.sandbox_db_name.clone())
            .ok_or_else(|| {
                ApiError::BadRequest(format!(
                    "Database {} not found in compare dump",
                    selected_db
                ))
            })?
    } else {
        compare_dump
            .sandbox_db_name
            .clone()
            .or_else(|| {
                compare_dump
                    .sandbox_databases
                    .as_ref()
                    .and_then(|dbs| dbs.first().cloned())
            })
            .ok_or_else(|| {
                ApiError::BadRequest("Compare dump has no sandbox database".to_string())
            })?
    };

    tracing::info!(
        "compare_table_data: using base_sandbox={}, compare_sandbox={}",
        base_sandbox_db,
        compare_sandbox_db
    );

    // Connect to both sandbox databases
    let base_pool = create_sandbox_pool(&state.config, &base_sandbox_db).await?;
    let compare_pool = create_sandbox_pool(&state.config, &compare_sandbox_db).await?;

    // Get primary key columns
    let pk_columns = get_primary_key_columns(&base_pool, &schema, &table).await?;

    // Get all column names
    let all_columns = get_table_columns(&base_pool, &schema, &table).await?;

    // If no primary key, use all columns as the key for comparison
    // This means we can only detect added/removed rows, not modified rows
    let (key_columns, can_detect_modified) = if pk_columns.is_empty() {
        tracing::info!(
            "Table {}.{} has no primary key, using all columns for comparison",
            schema,
            table
        );
        (all_columns.clone(), false)
    } else {
        (pk_columns.clone(), true)
    };

    let limit = query.limit.min(1000); // Cap at 1000 rows for output

    // For tables without PK, we need to fetch more rows to detect differences accurately
    // since we're comparing entire row contents
    let fetch_limit = if can_detect_modified {
        limit * 3 // With PK, we can be more selective
    } else {
        10000 // Without PK, fetch more rows for accurate comparison
    };

    // For detecting changes, compare non-key columns (only meaningful if we have a real PK)
    let non_pk_columns: Vec<_> = all_columns
        .iter()
        .filter(|c| !key_columns.contains(c))
        .cloned()
        .collect();

    // Query each table separately and compare in Rust
    let base_rows =
        fetch_table_rows(&base_pool, &schema, &table, &all_columns, fetch_limit).await?;
    let compare_rows =
        fetch_table_rows(&compare_pool, &schema, &table, &all_columns, fetch_limit).await?;

    tracing::info!(
        "compare_table_data: fetched {} base rows, {} compare rows (fetch_limit={})",
        base_rows.len(),
        compare_rows.len(),
        fetch_limit
    );

    // Build maps by key columns
    // For tables without PK, we use count maps to handle duplicate rows
    let base_count_map = build_row_count_map(&base_rows, &key_columns);
    let compare_count_map = build_row_count_map(&compare_rows, &key_columns);

    tracing::info!(
        "compare_table_data: base_count_map has {} unique keys (from {} rows), compare_count_map has {} unique keys (from {} rows)",
        base_count_map.len(),
        base_rows.len(),
        compare_count_map.len(),
        compare_rows.len()
    );

    let mut rows = Vec::new();
    let mut total_added: i64 = 0;
    let mut total_removed: i64 = 0;
    let mut total_modified: i64 = 0;

    // For tables without PK, compare counts to find added/removed rows
    // Find added rows: keys in compare that are not in base, or have higher count in compare
    for (key, (compare_count, compare_row)) in &compare_count_map {
        let base_count = base_count_map.get(key).map(|(c, _)| *c).unwrap_or(0);
        if compare_count > &base_count {
            let added_count = compare_count - base_count;
            total_added += added_count as i64;
            // Add one representative row to the diff output
            if rows.len() < limit {
                rows.push(RowDiff {
                    pk: key.clone(),
                    change_type: "added".to_string(),
                    base_values: None,
                    compare_values: Some(compare_row.clone()),
                    changed_columns: vec![],
                });
            }
        }
    }

    // Find removed and modified rows
    for (key, (base_count, base_row)) in &base_count_map {
        if let Some((compare_count, compare_row)) = compare_count_map.get(key) {
            // Check count difference - some instances were removed
            if base_count > compare_count {
                let removed_count = base_count - compare_count;
                total_removed += removed_count as i64;
                // Add representative row for partial removal
                if rows.len() < limit {
                    rows.push(RowDiff {
                        pk: key.clone(),
                        change_type: "removed".to_string(),
                        base_values: Some(base_row.clone()),
                        compare_values: Some(compare_row.clone()), // Still exists but fewer
                        changed_columns: vec![],
                    });
                }
            }

            // Check if modified (only if we have a real PK to compare non-key columns)
            if can_detect_modified && !non_pk_columns.is_empty() {
                let changed_cols = find_changed_columns(base_row, compare_row, &non_pk_columns);
                if !changed_cols.is_empty() {
                    total_modified += 1;
                    if rows.len() < limit {
                        rows.push(RowDiff {
                            pk: key.clone(),
                            change_type: "modified".to_string(),
                            base_values: Some(base_row.clone()),
                            compare_values: Some(compare_row.clone()),
                            changed_columns: changed_cols,
                        });
                    }
                }
            }
            // If using all columns as key, matching rows are identical (no modifications possible)
        } else {
            // Key not in compare at all - all instances are removed
            total_removed += *base_count as i64;
            if rows.len() < limit {
                rows.push(RowDiff {
                    pk: key.clone(),
                    change_type: "removed".to_string(),
                    base_values: Some(base_row.clone()),
                    compare_values: None,
                    changed_columns: vec![],
                });
            }
        }
    }

    let truncated = rows.len() >= limit;

    Ok(Json(TableDataDiffResponse {
        base_dump_id: base_id,
        compare_dump_id: compare_id,
        schema_name: schema,
        table_name: table,
        primary_key_columns: key_columns, // Return the actual key columns used
        total_added,
        total_removed,
        total_modified,
        rows,
        truncated,
    }))
}

/// Create a connection pool for a sandbox database
async fn create_sandbox_pool(
    config: &crate::config::AppConfig,
    sandbox_db_name: &str,
) -> Result<sqlx::PgPool, ApiError> {
    let url = format!(
        "postgres://{}:{}@{}:{}/{}",
        config.sandbox_user,
        config.sandbox_password.as_deref().unwrap_or("postgres"),
        config.sandbox_host,
        config.sandbox_port,
        sandbox_db_name
    );
    Ok(sqlx::PgPool::connect(&url).await?)
}

/// Get primary key columns for a table
async fn get_primary_key_columns(
    pool: &sqlx::PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, ApiError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        r#"
        SELECT kcu.column_name::text
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = $1
            AND tc.table_name = $2
        ORDER BY kcu.ordinal_position
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|(c,)| c).collect())
}

/// Get all column names for a table
async fn get_table_columns(
    pool: &sqlx::PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, ApiError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        r#"
        SELECT column_name::text
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|(c,)| c).collect())
}

/// Fetch rows from a table as JSON
async fn fetch_table_rows(
    pool: &sqlx::PgPool,
    schema: &str,
    table: &str,
    columns: &[String],
    limit: usize,
) -> Result<Vec<serde_json::Value>, ApiError> {
    let cols = columns
        .iter()
        .map(|c| format!("\"{}\"", c))
        .collect::<Vec<_>>()
        .join(", ");

    let query = format!(
        "SELECT row_to_json(t) FROM (SELECT {} FROM \"{}\".\"{}\" LIMIT {}) t",
        cols, schema, table, limit
    );

    let rows: Vec<(serde_json::Value,)> = sqlx::query_as(&query).fetch_all(pool).await?;

    Ok(rows.into_iter().map(|(v,)| v).collect())
}

/// Build a count map of rows keyed by their key column values
/// Returns a map of (key -> (count, sample_row))
/// This handles duplicate rows by counting occurrences
fn build_row_count_map(
    rows: &[serde_json::Value],
    key_columns: &[String],
) -> std::collections::HashMap<serde_json::Value, (usize, serde_json::Value)> {
    let mut map: std::collections::HashMap<serde_json::Value, (usize, serde_json::Value)> =
        std::collections::HashMap::new();

    for row in rows {
        if let Some(obj) = row.as_object() {
            let key_value: serde_json::Value = if key_columns.len() == 1 {
                obj.get(&key_columns[0])
                    .cloned()
                    .unwrap_or(serde_json::Value::Null)
            } else {
                serde_json::json!(key_columns
                    .iter()
                    .map(|c| obj.get(c).cloned().unwrap_or(serde_json::Value::Null))
                    .collect::<Vec<_>>())
            };

            map.entry(key_value)
                .and_modify(|(count, _)| *count += 1)
                .or_insert((1, row.clone()));
        }
    }

    map
}

/// Find which columns have changed between two row values
fn find_changed_columns(
    base: &serde_json::Value,
    compare: &serde_json::Value,
    non_pk_columns: &[String],
) -> Vec<String> {
    let mut changed = Vec::new();

    if let (Some(base_obj), Some(compare_obj)) = (base.as_object(), compare.as_object()) {
        for col in non_pk_columns {
            let base_val = base_obj.get(col);
            let compare_val = compare_obj.get(col);
            if base_val != compare_val {
                changed.push(col.clone());
            }
        }
    }

    changed
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
