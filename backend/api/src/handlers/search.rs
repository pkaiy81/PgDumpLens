//! Search handlers

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

/// Search query parameters
#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    /// Search keyword
    pub q: String,
    /// Maximum results per table (default: 10)
    pub limit: Option<usize>,
    /// Optional database name filter
    pub database: Option<String>,
}

/// Search result item
#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub database_name: String,
    pub schema_name: String,
    pub table_name: String,
    pub column_name: String,
    pub matched_value: serde_json::Value,
    pub row_data: serde_json::Value,
    pub sql_query: String,
}

/// Search response
#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub query: String,
    pub total_results: usize,
    pub results: Vec<SearchResult>,
    pub searched_tables: usize,
}

/// Search across all tables in a dump
pub async fn search_in_dump(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(query): Query<SearchQuery>,
) -> ApiResult<Json<SearchResponse>> {
    let limit = query.limit.unwrap_or(10).min(100);
    let search_term = query.q.trim();

    if search_term.is_empty() {
        return Err(ApiError::BadRequest(
            "Search query cannot be empty".to_string(),
        ));
    }

    // Get dump info
    let dump_row = sqlx::query(
        r#"
        SELECT sandbox_db_name, sandbox_databases, status
        FROM dumps
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db_pool)
    .await?;

    let row = dump_row.ok_or_else(|| ApiError::NotFound(format!("Dump {} not found", id)))?;

    let status: String = row.get("status");
    if status != "READY" {
        return Err(ApiError::BadRequest(format!(
            "Dump is not ready for search (status: {})",
            status
        )));
    }

    let sandbox_db_name: Option<String> = row.get("sandbox_db_name");
    let sandbox_databases: Option<Vec<String>> = row.get("sandbox_databases");

    // Determine which databases to search
    let databases_to_search = if let Some(ref filter_db) = query.database {
        vec![filter_db.clone()]
    } else {
        sandbox_databases
            .clone()
            .unwrap_or_else(|| sandbox_db_name.clone().map_or(vec![], |db| vec![db]))
    };

    // Get schema graph for table information
    let schema_rows = sqlx::query(
        r#"
        SELECT database_name, schema_graph
        FROM dump_schemas
        WHERE dump_id = $1
        "#,
    )
    .bind(id)
    .fetch_all(&state.db_pool)
    .await?;

    let mut all_results = Vec::new();
    let mut searched_tables = 0;

    for db_name in databases_to_search {
        // Find matching schema graph
        let schema_graph: Option<SchemaGraph> = schema_rows
            .iter()
            .find(|r| {
                let db: String = r.get("database_name");
                db == db_name
            })
            .map(|r| {
                let SqlxJson(graph): SqlxJson<SchemaGraph> = r.get("schema_graph");
                graph
            });

        if schema_graph.is_none() {
            continue;
        }

        let graph = schema_graph.unwrap();

        // Connect to sandbox database
        let db_url = format!(
            "postgres://{}:{}@{}:{}/{}",
            state.config.sandbox_user,
            state.config.sandbox_password.as_deref().unwrap_or(""),
            state.config.sandbox_host,
            state.config.sandbox_port,
            db_name
        );

        let db_pool = match sqlx::PgPool::connect(&db_url).await {
            Ok(pool) => pool,
            Err(_) => continue,
        };

        // Search in each table
        for table in &graph.tables {
            searched_tables += 1;

            // Search in each text-like column
            for column in &table.columns {
                let column_type = column.data_type.to_lowercase();

                // Only search in text-compatible columns
                if !column_type.contains("char")
                    && !column_type.contains("text")
                    && !column_type.contains("json")
                {
                    continue;
                }

                // Build search query
                let search_query = format!(
                    r#"
                    SELECT to_jsonb(t.*) as row_data, "{}" as matched_value
                    FROM "{}"."{}" t
                    WHERE CAST("{}" AS TEXT) ILIKE $1
                    LIMIT {}
                    "#,
                    column.name, table.schema_name, table.table_name, column.name, limit
                );

                let search_pattern = format!("%{}%", search_term);

                let rows = match sqlx::query(&search_query)
                    .bind(&search_pattern)
                    .fetch_all(&db_pool)
                    .await
                {
                    Ok(rows) => rows,
                    Err(_) => continue,
                };

                for row in rows {
                    let row_data: serde_json::Value = row.get("row_data");
                    let matched_value_str: String = row.get("matched_value");
                    let matched_value = serde_json::Value::String(matched_value_str);

                    // Generate SQL for reproducing this search
                    let sql_query = format!(
                        r#"-- Search in {}.{}.{}.{}
SELECT * FROM "{}"."{}"
WHERE CAST("{}" AS TEXT) ILIKE '%{}%'
LIMIT {};"#,
                        db_name,
                        table.schema_name,
                        table.table_name,
                        column.name,
                        table.schema_name,
                        table.table_name,
                        column.name,
                        search_term,
                        limit
                    );

                    all_results.push(SearchResult {
                        database_name: db_name.clone(),
                        schema_name: table.schema_name.clone(),
                        table_name: table.table_name.clone(),
                        column_name: column.name.clone(),
                        matched_value,
                        row_data,
                        sql_query,
                    });

                    if all_results.len() >= 100 {
                        break;
                    }
                }

                if all_results.len() >= 100 {
                    break;
                }
            }

            if all_results.len() >= 100 {
                break;
            }
        }

        if all_results.len() >= 100 {
            break;
        }
    }

    Ok(Json(SearchResponse {
        query: search_term.to_string(),
        total_results: all_results.len(),
        results: all_results,
        searched_tables,
    }))
}
