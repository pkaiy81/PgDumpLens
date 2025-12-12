//! Risk assessment handlers

use axum::{
    extract::{Path, State},
    Json,
};
use serde::Serialize;
use sqlx::types::Json as SqlxJson;
use sqlx::Row;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use db_viewer_core::domain::SchemaGraph;
use db_viewer_core::risk::{RiskCalculator, RiskScore};

/// Risk response with additional context
#[derive(Debug, Serialize)]
pub struct RiskResponse {
    #[serde(flatten)]
    pub risk: RiskScore,
    pub schema: String,
    pub table: String,
    pub column: Option<String>,
}

/// Get table-level risk score
pub async fn get_table_risk(
    State(state): State<AppState>,
    Path((id, schema, table)): Path<(Uuid, String, String)>,
) -> ApiResult<Json<RiskResponse>> {
    let schema_graph = fetch_schema_graph(&state, id).await?;
    let calc = RiskCalculator::new(&schema_graph);
    let risk = calc.calculate_table_risk(&schema, &table);

    Ok(Json(RiskResponse {
        risk,
        schema,
        table,
        column: None,
    }))
}

/// Get column-level risk score
pub async fn get_column_risk(
    State(state): State<AppState>,
    Path((id, schema, table, column)): Path<(Uuid, String, String, String)>,
) -> ApiResult<Json<RiskResponse>> {
    let schema_graph = fetch_schema_graph(&state, id).await?;
    let calc = RiskCalculator::new(&schema_graph);

    // For now, use 0 as referencing count (would need actual query in production)
    let risk = calc.calculate_column_risk(&schema, &table, &column, 0);

    Ok(Json(RiskResponse {
        risk,
        schema,
        table,
        column: Some(column),
    }))
}

async fn fetch_schema_graph(state: &AppState, dump_id: Uuid) -> ApiResult<SchemaGraph> {
    let row = sqlx::query("SELECT schema_graph FROM dump_schemas WHERE dump_id = $1")
        .bind(dump_id)
        .fetch_optional(&state.db_pool)
        .await?;

    match row {
        Some(row) => {
            let SqlxJson(schema_graph): SqlxJson<SchemaGraph> = row.get("schema_graph");
            Ok(schema_graph)
        }
        None => Err(ApiError::NotFound(format!(
            "Schema not found for dump {}",
            dump_id
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use db_viewer_core::risk::RiskLevel;

    #[test]
    fn test_risk_response_serialization() {
        let response = RiskResponse {
            risk: RiskScore {
                score: 75,
                level: RiskLevel::High,
                reasons: vec!["Test reason".to_string()],
            },
            schema: "public".to_string(),
            table: "users".to_string(),
            column: Some("id".to_string()),
        };

        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"score\":75"));
        assert!(json.contains("\"level\":\"high\""));
    }
}
