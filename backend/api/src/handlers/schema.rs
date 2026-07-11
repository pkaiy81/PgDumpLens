//! Schema and data handlers

use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::types::Json as SqlxJson;
use sqlx::Row;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::handlers::sandbox::{
    build_sandbox_url, extract_original_db_name, find_sandbox_db_name, resolve_sandbox_db,
};
use crate::state::AppState;
use db_viewer_core::domain::SchemaGraph;
use db_viewer_core::schema::generate_mermaid_er;

/// Quote a SQL identifier safely by wrapping it in double quotes and escaping
/// any embedded double quotes.
fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// Escape a value for use inside a `LIKE` / `ILIKE` pattern so that `%`, `_`
/// and `\` are treated literally (used together with `ESCAPE '\'`).
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Get schema response
#[derive(Debug, Serialize)]
pub struct SchemaResponse {
    pub schema_graph: SchemaGraph,
    pub mermaid_er: String,
}

/// Schema query parameters
#[derive(Debug, Deserialize)]
pub struct SchemaQuery {
    /// Optional database name for pg_dumpall dumps with multiple databases
    pub database: Option<String>,
}

/// Get schema for a dump
pub async fn get_schema(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(query): Query<SchemaQuery>,
) -> ApiResult<Json<SchemaResponse>> {
    // First, fetch dump info
    let dump_row = sqlx::query(
        r#"
        SELECT sandbox_databases, sandbox_db_name
        FROM dumps
        WHERE id = $1 AND status = 'READY'
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db_pool)
    .await?
    .ok_or_else(|| ApiError::NotFound(format!("Dump {} not found or not ready", id)))?;

    let available_dbs: Option<Vec<String>> = dump_row.get("sandbox_databases");
    let primary_db: Option<String> = dump_row.get("sandbox_db_name");

    // Determine which database to use
    let requested_db = if let Some(ref user_db) = query.database {
        // User requested a specific database by user-friendly name
        // Find the corresponding sandbox database name
        let sandbox_db = find_sandbox_db_name(&available_dbs, user_db).or_else(|| {
            // Check if user_db matches primary_db directly or as extracted name
            primary_db.as_ref().and_then(|pdb| {
                if pdb == user_db || extract_original_db_name(pdb) == *user_db {
                    Some(pdb.clone())
                } else {
                    None
                }
            })
        });

        match sandbox_db {
            Some(db) => db,
            None => {
                // Database not found - show user-friendly names in error
                let friendly_names: Vec<String> = available_dbs
                    .as_ref()
                    .map(|dbs| dbs.iter().map(|d| extract_original_db_name(d)).collect())
                    .unwrap_or_else(|| {
                        primary_db
                            .iter()
                            .map(|p| extract_original_db_name(p))
                            .collect()
                    });
                return Err(ApiError::BadRequest(format!(
                    "Database '{}' is not available for this dump. Available: {:?}",
                    user_db, friendly_names
                )));
            }
        }
    } else {
        // No database specified - use the first available database
        available_dbs
            .and_then(|dbs| dbs.first().cloned())
            .or(primary_db)
            .ok_or_else(|| ApiError::NotFound(format!("No database found for dump {}", id)))?
    };

    // Fetch cached schema from metadata DB
    let row = sqlx::query(
        r#"
        SELECT schema_graph
        FROM dump_schemas
        WHERE dump_id = $1 AND database_name = $2
        "#,
    )
    .bind(id)
    .bind(&requested_db)
    .fetch_optional(&state.db_pool)
    .await?;

    match row {
        Some(row) => {
            let SqlxJson(schema_graph): SqlxJson<SchemaGraph> = row.get("schema_graph");
            let mermaid_er = generate_mermaid_er(&schema_graph);

            Ok(Json(SchemaResponse {
                schema_graph,
                mermaid_er,
            }))
        }
        None => Err(ApiError::NotFound(format!(
            "Schema not found for dump {} database '{}'. Ensure the dump is in READY state.",
            id, requested_db
        ))),
    }
}

/// Table data query parameters
#[derive(Debug, Deserialize)]
pub struct TableDataQuery {
    pub schema: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    /// Case-insensitive substring filter applied server-side (SQL `ILIKE`).
    pub filter: Option<String>,
    /// Optional column to restrict the filter to. When omitted, the filter is
    /// applied across all columns (free-text search).
    pub filter_column: Option<String>,
    /// Optional database name for pg_dumpall dumps with multiple databases
    pub database: Option<String>,
}

/// Table data response
#[derive(Debug, Serialize)]
pub struct TableDataResponse {
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
    pub rows: Vec<serde_json::Value>,
    pub total_count: i64,
    pub limit: usize,
    pub offset: usize,
    /// Echo of the applied filter (if any).
    pub filter: Option<String>,
}

/// Get table data
pub async fn get_table_data(
    State(state): State<AppState>,
    Path((id, table_path)): Path<(Uuid, String)>,
    Query(query): Query<TableDataQuery>,
) -> ApiResult<Json<TableDataResponse>> {
    // Parse schema.table format or use query parameter
    let parts: Vec<&str> = table_path.split('.').collect();
    let (schema, table) = if parts.len() == 2 {
        (parts[0].to_string(), parts[1].to_string())
    } else {
        // Use query parameter for schema, default to "public"
        let schema = query.schema.clone().unwrap_or_else(|| "public".to_string());
        (schema, parts[0].to_string())
    };

    // Get sandbox database name - use query.database if specified, otherwise fallback to sandbox_db_name
    let sandbox_db = resolve_sandbox_db(&state.db_pool, id, query.database.as_deref()).await?;

    let limit = query.limit.unwrap_or(50).min(1000);
    let offset = query.offset.unwrap_or(0);

    // Connect to sandbox and fetch data
    let sandbox_url = build_sandbox_url(&state.config, &sandbox_db);

    let sandbox_pool = sqlx::postgres::PgPool::connect(&sandbox_url)
        .await
        .map_err(|e| ApiError::Internal(format!("Failed to connect to sandbox: {}", e)))?;

    // Get column names
    let columns: Vec<String> = sqlx::query(
        r#"
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
        "#,
    )
    .bind(&schema)
    .bind(&table)
    .fetch_all(&sandbox_pool)
    .await?
    .iter()
    .map(|row| row.get("column_name"))
    .collect();

    if columns.is_empty() {
        return Err(ApiError::NotFound(format!(
            "Table {}.{} not found",
            schema, table
        )));
    }

    // Build an optional WHERE clause for server-side filtering. The filter value
    // is always bound as $1 (never interpolated) so it is safe against quotes;
    // identifiers are quoted via `quote_ident`.
    let filter_value = query
        .filter
        .as_deref()
        .map(str::trim)
        .filter(|f| !f.is_empty());

    let where_clause = if filter_value.is_some() {
        if let Some(ref col) = query.filter_column {
            if !columns.iter().any(|c| c == col) {
                return Err(ApiError::BadRequest(format!(
                    "Filter column '{}' does not exist in table {}.{}",
                    col, schema, table
                )));
            }
            format!("WHERE t.{}::text ILIKE $1 ESCAPE '\\'", quote_ident(col))
        } else {
            // Free-text search across all columns
            let conditions: Vec<String> = columns
                .iter()
                .map(|c| format!("t.{}::text ILIKE $1 ESCAPE '\\'", quote_ident(c)))
                .collect();
            format!("WHERE ({})", conditions.join(" OR "))
        }
    } else {
        String::new()
    };

    let bind_pattern = filter_value.map(|f| format!("%{}%", escape_like(f)));

    let table_ref = format!("{}.{}", quote_ident(&schema), quote_ident(&table));

    // Get total count (with the same filter applied)
    let count_query = format!(
        "SELECT COUNT(*) as cnt FROM {} t {}",
        table_ref, where_clause
    );
    let mut count_q = sqlx::query(&count_query);
    if let Some(ref pattern) = bind_pattern {
        count_q = count_q.bind(pattern);
    }
    let count_row = count_q.fetch_one(&sandbox_pool).await?;
    let total_count: i64 = count_row.get("cnt");

    // Fetch rows (limit/offset are clamped usize values, safe to interpolate)
    let data_query = format!(
        "SELECT to_jsonb(t.*) as row_data FROM {} t {} LIMIT {} OFFSET {}",
        table_ref, where_clause, limit, offset
    );
    let mut data_q = sqlx::query(&data_query);
    if let Some(ref pattern) = bind_pattern {
        data_q = data_q.bind(pattern);
    }
    let rows: Vec<serde_json::Value> = data_q
        .fetch_all(&sandbox_pool)
        .await?
        .iter()
        .map(|row| row.get("row_data"))
        .collect();

    Ok(Json(TableDataResponse {
        schema,
        table,
        columns,
        rows,
        total_count,
        limit,
        offset,
        filter: filter_value.map(|f| f.to_string()),
    }))
}

/// Suggest query parameters
#[derive(Debug, Deserialize)]
pub struct SuggestQuery {
    pub schema: Option<String>,
    pub table: String,
    pub column: String,
    pub prefix: Option<String>,
    pub limit: Option<usize>,
}

/// Suggest response
#[derive(Debug, Serialize)]
pub struct SuggestResponse {
    pub suggestions: Vec<SuggestItem>,
}

/// Single suggestion item
#[derive(Debug, Serialize)]
pub struct SuggestItem {
    pub value: serde_json::Value,
    pub frequency: i64,
    pub source: String,
}

/// Get value suggestions
pub async fn suggest_values(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(query): Query<SuggestQuery>,
) -> ApiResult<Json<SuggestResponse>> {
    let schema = query.schema.as_deref().unwrap_or("public");
    let limit = query.limit.unwrap_or(10).min(50);

    // Get sandbox database
    let dump_row = sqlx::query("SELECT sandbox_db_name FROM dumps WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db_pool)
        .await?;

    let sandbox_db: String = match dump_row {
        Some(row) => row
            .get::<Option<String>, _>("sandbox_db_name")
            .ok_or_else(|| ApiError::BadRequest("Dump not restored yet".to_string()))?,
        None => return Err(ApiError::NotFound(format!("Dump {} not found", id))),
    };

    let sandbox_url = build_sandbox_url(&state.config, &sandbox_db);

    let sandbox_pool = sqlx::postgres::PgPool::connect(&sandbox_url)
        .await
        .map_err(|e| ApiError::Internal(format!("Failed to connect to sandbox: {}", e)))?;

    // Build suggestion query
    let suggest_query = if let Some(ref _prefix) = query.prefix {
        format!(
            r#"
            SELECT "{}" as value, COUNT(*) as frequency
            FROM "{}"."{}"
            WHERE "{}"::text ILIKE $1
            GROUP BY "{}"
            ORDER BY frequency DESC
            LIMIT {}
            "#,
            query.column, schema, query.table, query.column, query.column, limit
        )
    } else {
        format!(
            r#"
            SELECT "{}" as value, COUNT(*) as frequency
            FROM "{}"."{}"
            GROUP BY "{}"
            ORDER BY frequency DESC
            LIMIT {}
            "#,
            query.column, schema, query.table, query.column, limit
        )
    };

    let rows = if let Some(prefix) = &query.prefix {
        sqlx::query(&suggest_query)
            .bind(format!("{}%", prefix))
            .fetch_all(&sandbox_pool)
            .await?
    } else {
        sqlx::query(&suggest_query).fetch_all(&sandbox_pool).await?
    };

    let suggestions: Vec<SuggestItem> = rows
        .iter()
        .map(|row| SuggestItem {
            value: row.get("value"),
            frequency: row.get("frequency"),
            source: "frequency".to_string(),
        })
        .collect();

    Ok(Json(SuggestResponse { suggestions }))
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    fn test_parse_table_path_with_schema() {
        let table_path = "public.users";
        let parts: Vec<&str> = table_path.split('.').collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], "public");
        assert_eq!(parts[1], "users");
    }

    #[test]
    fn test_parse_table_path_without_schema() {
        let table_path = "users";
        let parts: Vec<&str> = table_path.split('.').collect();
        assert_eq!(parts.len(), 1);
        let (schema, table) = if parts.len() == 2 {
            (parts[0], parts[1])
        } else {
            ("public", parts[0])
        };
        assert_eq!(schema, "public");
        assert_eq!(table, "users");
    }

    #[test]
    fn test_quote_ident_plain() {
        assert_eq!(quote_ident("users"), "\"users\"");
    }

    #[test]
    fn test_quote_ident_embedded_quote() {
        // A double quote inside the identifier must be doubled.
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
    }

    #[test]
    fn test_escape_like_special_chars() {
        assert_eq!(escape_like("100%"), "100\\%");
        assert_eq!(escape_like("a_b"), "a\\_b");
        assert_eq!(escape_like("back\\slash"), "back\\\\slash");
    }

    #[test]
    fn test_escape_like_backslash_first() {
        // Backslash must be escaped before % and _ to avoid double-escaping.
        assert_eq!(escape_like("\\%"), "\\\\\\%");
    }
}
