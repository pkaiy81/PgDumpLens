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
pub struct ExplainRelationRequest {
    pub schema: String,
    pub table: String,
    pub column: String,
    pub value: serde_json::Value,
    pub max_hops: Option<usize>,
}

/// Explain relation response
#[derive(Debug, Serialize)]
pub struct ExplainRelationResponse {
    pub explanations: Vec<RelationExplanation>,
    pub sql_examples: Vec<String>,
}

/// Explain relationships for a value
pub async fn explain_relation(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<ExplainRelationRequest>,
) -> ApiResult<Json<ExplainRelationResponse>> {
    let _max_hops = req.max_hops.unwrap_or(2).min(5);

    // Fetch schema graph
    let schema_row = sqlx::query("SELECT schema_graph FROM dump_schemas WHERE dump_id = $1")
        .bind(id)
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
