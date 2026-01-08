//! Relationship explanation handlers

use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::types::Json as SqlxJson;
use sqlx::Row;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use db_viewer_core::domain::{RelationDirection, RelationExplanation, SchemaGraph};
use db_viewer_core::risk::RiskCalculator;
use db_viewer_core::sql_gen::SqlGenerator;

/// Explain relation request
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct ExplainRelationRequest {
    pub schema: String,
    pub table: String,
    pub column: String,
    pub value: serde_json::Value,
    pub max_hops: Option<usize>,
    /// Optional database name for multi-database dumps
    pub database: Option<String>,
}

/// Explain relation response
#[derive(Debug, Serialize)]
pub struct ExplainRelationResponse {
    pub explanations: Vec<RelationExplanation>,
    pub sql_examples: Vec<String>,
}

/// Find sandbox database name for a given original database name
///
/// For pg_dumpall dumps, sandbox databases are named: sandbox_{dump_id}_{original_db_name}
/// This function looks through the sandbox_databases array to find a match.
fn find_sandbox_db_for_original(
    sandbox_databases: &[String],
    original_db_name: &str,
) -> Option<String> {
    // Look for a sandbox database that:
    // 1. Ends with _{original_db_name} (prefixed format: sandbox_{dump_id}_{db_name})
    // 2. OR exactly matches original_db_name (old format: db_name directly)
    let suffix = format!("_{}", original_db_name);
    sandbox_databases
        .iter()
        .find(|db| db.ends_with(&suffix) || *db == original_db_name)
        .cloned()
}

/// Explain relationships for a value
pub async fn explain_relation(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<ExplainRelationRequest>,
) -> ApiResult<Json<ExplainRelationResponse>> {
    let _max_hops = req.max_hops.unwrap_or(2).min(5);

    // Get dump info including sandbox databases
    let row = sqlx::query(
        r#"
        SELECT sandbox_db_name, sandbox_databases
        FROM dumps
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db_pool)
    .await?
    .ok_or_else(|| ApiError::NotFound(format!("Dump {} not found", id)))?;

    let primary_sandbox_db: Option<String> = row.get("sandbox_db_name");
    let sandbox_databases: Option<Vec<String>> = row.get("sandbox_databases");

    // Determine which sandbox database to use
    // If req.database is specified (original db name like "platform"),
    // we need to find the full sandbox name (like "sandbox_abc123_platform")
    let sandbox_db_name = if let Some(ref original_db) = req.database {
        // User specified a database - find the corresponding sandbox database
        if let Some(ref dbs) = sandbox_databases {
            find_sandbox_db_for_original(dbs, original_db)
                .or_else(|| primary_sandbox_db.clone())
                .ok_or_else(|| {
                    ApiError::NotFound(format!("Database {} not found in dump", original_db))
                })?
        } else {
            // No sandbox_databases array, use primary
            primary_sandbox_db
                .ok_or_else(|| ApiError::NotFound(format!("No database found for dump {}", id)))?
        }
    } else {
        // No database specified - use first from sandbox_databases or primary
        sandbox_databases
            .and_then(|dbs| dbs.first().cloned())
            .or(primary_sandbox_db)
            .ok_or_else(|| ApiError::NotFound(format!("No database found for dump {}", id)))?
    };

    tracing::info!(
        "explain_relation: sandbox_db={} for dump {}",
        sandbox_db_name,
        id
    );

    // Fetch schema graph for the specific database
    // dump_schemas stores the full sandbox database name (e.g., sandbox_abc123_platform)
    let schema_row = sqlx::query(
        "SELECT schema_graph FROM dump_schemas WHERE dump_id = $1 AND database_name = $2",
    )
    .bind(id)
    .bind(&sandbox_db_name)
    .fetch_optional(&state.db_pool)
    .await?;

    let schema_graph: SchemaGraph = match schema_row {
        Some(row) => {
            let SqlxJson(graph): SqlxJson<SchemaGraph> = row.get("schema_graph");
            graph
        }
        None => {
            return Err(ApiError::NotFound(format!(
                "Schema not found for dump {}",
                id
            )))
        }
    };

    let risk_calc = RiskCalculator::new(&schema_graph);
    let mut explanations = Vec::new();

    // Find inbound relationships (tables that reference this column)
    for fk in &schema_graph.foreign_keys {
        if fk.target_schema == req.schema
            && fk.target_table == req.table
            && fk.target_columns.contains(&req.column)
        {
            let risk = risk_calc.calculate_column_risk(
                &req.schema,
                &req.table,
                &req.column,
                0, // TODO: Get actual referencing count
            );

            explanations.push(RelationExplanation {
                source_table: format!("{}.{}", fk.source_schema, fk.source_table),
                source_column: fk.source_columns.join(", "),
                target_table: format!("{}.{}", fk.target_schema, fk.target_table),
                target_column: fk.target_columns.join(", "),
                direction: RelationDirection::Inbound,
                path_length: 1,
                sample_rows: vec![],
                sql_example: SqlGenerator::generate_referencing_query(fk, "$1", 50),
                risk_score: risk.score,
                risk_reasons: risk.reasons,
            });
        }
    }

    // Find outbound relationships (this column references another table)
    for fk in &schema_graph.foreign_keys {
        if fk.source_schema == req.schema
            && fk.source_table == req.table
            && fk.source_columns.contains(&req.column)
        {
            explanations.push(RelationExplanation {
                source_table: format!("{}.{}", fk.source_schema, fk.source_table),
                source_column: fk.source_columns.join(", "),
                target_table: format!("{}.{}", fk.target_schema, fk.target_table),
                target_column: fk.target_columns.join(", "),
                direction: RelationDirection::Outbound,
                path_length: 1,
                sample_rows: vec![],
                sql_example: SqlGenerator::generate_join_query(fk, "$1", 50),
                risk_score: 0,
                risk_reasons: vec![],
            });
        }
    }

    // Generate SQL examples
    let sql_examples = SqlGenerator::generate_relationship_sql(
        &schema_graph,
        &req.schema,
        &req.table,
        &req.column,
        RelationDirection::Inbound,
        "$1",
    );

    Ok(Json(ExplainRelationResponse {
        explanations,
        sql_examples,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_explain_request_deserialization() {
        let json = r#"{
            "schema": "public",
            "table": "users",
            "column": "id",
            "value": 123
        }"#;

        let req: ExplainRelationRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.schema, "public");
        assert_eq!(req.table, "users");
        assert_eq!(req.column, "id");
        assert_eq!(req.max_hops, None);
    }
}
