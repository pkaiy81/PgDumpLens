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
use crate::state::AppState;
use db_viewer_core::domain::SchemaGraph;
use db_viewer_core::schema::generate_mermaid_er;

/// Get schema response
#[derive(Debug, Serialize)]
pub struct SchemaResponse {
    pub schema_graph: SchemaGraph,
    pub mermaid_er: String,
}

/// Get schema for a dump
pub async fn get_schema(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<SchemaResponse>> {
    // Fetch cached schema from metadata DB
    let row = sqlx::query(
        r#"
        SELECT schema_graph
        FROM dump_schemas
        WHERE dump_id = $1
        "#,
    )
    .bind(id)
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
            "Schema not found for dump {}. Ensure the dump is in READY state.",
            id
        ))),
    }
}

/// Table data query parameters
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct TableDataQuery {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    pub filter: Option<String>,
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
}

/// Get table data
pub async fn get_table_data(
    State(state): State<AppState>,
    Path((id, table_path)): Path<(Uuid, String)>,
    Query(query): Query<TableDataQuery>,
) -> ApiResult<Json<TableDataResponse>> {
    // Parse schema.table format
    let parts: Vec<&str> = table_path.split('.').collect();
    let (schema, table) = if parts.len() == 2 {
        (parts[0], parts[1])
    } else {
        ("public", parts[0])
    };

    // Get sandbox database name
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

    let limit = query.limit.unwrap_or(50).min(1000);
    let offset = query.offset.unwrap_or(0);

    // Connect to sandbox and fetch data
    let sandbox_url = format!(
        "postgres://{}@{}:{}/{}",
        state.config.sandbox_user, state.config.sandbox_host, state.config.sandbox_port, sandbox_db
    );

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
    .bind(schema)
    .bind(table)
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

    // Get total count
    let count_query = format!("SELECT COUNT(*) as cnt FROM \"{}\".\"{}\"", schema, table);
    let count_row = sqlx::query(&count_query).fetch_one(&sandbox_pool).await?;
    let total_count: i64 = count_row.get("cnt");

    // Fetch rows
    let data_query = format!(
        "SELECT to_jsonb(t.*) as row_data FROM \"{}\".\"{}\" t LIMIT {} OFFSET {}",
        schema, table, limit, offset
    );
    let rows: Vec<serde_json::Value> = sqlx::query(&data_query)
        .fetch_all(&sandbox_pool)
        .await?
        .iter()
        .map(|row| row.get("row_data"))
        .collect();

    Ok(Json(TableDataResponse {
        schema: schema.to_string(),
        table: table.to_string(),
        columns,
        rows,
        total_count,
        limit,
        offset,
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

    let sandbox_url = format!(
        "postgres://{}@{}:{}/{}",
        state.config.sandbox_user, state.config.sandbox_host, state.config.sandbox_port, sandbox_db
    );

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

    let rows = if query.prefix.is_some() {
        sqlx::query(&suggest_query)
            .bind(format!("{}%", query.prefix.as_ref().unwrap()))
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
}
