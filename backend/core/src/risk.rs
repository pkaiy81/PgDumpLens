//! Risk scoring module for data modification assessment

use crate::domain::{FkAction, ForeignKey, SchemaGraph, TableInfo};
use serde::{Deserialize, Serialize};

/// Risk score result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskScore {
    /// Numeric score from 0-100
    pub score: u8,
    /// Human-readable risk level
    pub level: RiskLevel,
    /// Reasons for the risk score
    pub reasons: Vec<String>,
}

/// Risk level classification
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

impl RiskLevel {
    pub fn from_score(score: u8) -> Self {
        match score {
            0..=25 => RiskLevel::Low,
            26..=50 => RiskLevel::Medium,
            51..=75 => RiskLevel::High,
            _ => RiskLevel::Critical,
        }
    }
}

/// Risk calculator for assessing modification/deletion risk
pub struct RiskCalculator<'a> {
    schema_graph: &'a SchemaGraph,
}

impl<'a> RiskCalculator<'a> {
    pub fn new(schema_graph: &'a SchemaGraph) -> Self {
        Self { schema_graph }
    }

    /// Calculate risk score for deleting a row from a table
    pub fn calculate_table_risk(&self, schema: &str, table: &str) -> RiskScore {
        let mut score: u32 = 0;
        let mut reasons = Vec::new();

        // Find inbound foreign keys (tables that reference this table)
        let inbound_fks: Vec<&ForeignKey> = self
            .schema_graph
            .foreign_keys
            .iter()
            .filter(|fk| fk.target_schema == schema && fk.target_table == table)
            .collect();

        // Factor 1: Number of inbound foreign keys
        let inbound_count = inbound_fks.len();
        if inbound_count > 0 {
            let fk_score = (inbound_count * 10).min(30) as u32;
            score += fk_score;
            reasons.push(format!(
                "{} table(s) reference this table via foreign keys",
                inbound_count
            ));
        }

        // Factor 2: CASCADE delete behavior
        let cascade_count = inbound_fks
            .iter()
            .filter(|fk| fk.on_delete == FkAction::Cascade)
            .count();
        if cascade_count > 0 {
            let cascade_score = (cascade_count * 15).min(30) as u32;
            score += cascade_score;
            reasons.push(format!(
                "{} foreign key(s) have ON DELETE CASCADE - deletion will propagate",
                cascade_count
            ));
        }

        // Factor 3: RESTRICT behavior (prevents deletion)
        let restrict_count = inbound_fks
            .iter()
            .filter(|fk| fk.on_delete == FkAction::Restrict || fk.on_delete == FkAction::NoAction)
            .count();
        if restrict_count > 0 && inbound_count > cascade_count {
            score += 10;
            reasons.push(format!(
                "{} foreign key(s) will block deletion if referenced",
                restrict_count
            ));
        }

        // Factor 4: Estimated row count
        if let Some(table_info) = self.find_table(schema, table) {
            if table_info.estimated_row_count > 10000 {
                score += 10;
                reasons.push(format!(
                    "Large table with ~{} rows",
                    table_info.estimated_row_count
                ));
            }
        }

        // Factor 5: Primary key involvement
        if let Some(table_info) = self.find_table(schema, table) {
            let has_pk = table_info.columns.iter().any(|c| c.is_primary_key);
            if has_pk && inbound_count > 0 {
                score += 10;
                reasons.push("Table has primary key referenced by other tables".to_string());
            }
        }

        // Cap the score at 100
        let final_score = score.min(100) as u8;

        RiskScore {
            score: final_score,
            level: RiskLevel::from_score(final_score),
            reasons,
        }
    }

    /// Calculate risk for a specific column value
    pub fn calculate_column_risk(
        &self,
        schema: &str,
        table: &str,
        column: &str,
        referencing_count: i64,
    ) -> RiskScore {
        let mut score: u32 = 0;
        let mut reasons = Vec::new();

        // Find FKs that reference this specific column
        let column_refs: Vec<&ForeignKey> = self
            .schema_graph
            .foreign_keys
            .iter()
            .filter(|fk| {
                fk.target_schema == schema
                    && fk.target_table == table
                    && fk.target_columns.contains(&column.to_string())
            })
            .collect();

        // Factor 1: Number of referencing rows
        if referencing_count > 0 {
            let ref_score = match referencing_count {
                1..=10 => 10,
                11..=100 => 20,
                101..=1000 => 30,
                _ => 40,
            };
            score += ref_score as u32;
            reasons.push(format!(
                "{} row(s) in other tables reference this value",
                referencing_count
            ));
        }

        // Factor 2: CASCADE behavior on referencing FKs
        for fk in &column_refs {
            if fk.on_delete == FkAction::Cascade {
                score += 20;
                reasons.push(format!(
                    "Deletion will cascade to {}.{}",
                    fk.source_schema, fk.source_table
                ));
            }
        }

        // Factor 3: Primary key column
        if let Some(table_info) = self.find_table(schema, table) {
            let is_pk = table_info
                .columns
                .iter()
                .any(|c| c.name == column && c.is_primary_key);
            if is_pk {
                score += 15;
                reasons.push("This is a primary key column".to_string());
            }
        }

        let final_score = score.min(100) as u8;

        RiskScore {
            score: final_score,
            level: RiskLevel::from_score(final_score),
            reasons,
        }
    }

    fn find_table(&self, schema: &str, table: &str) -> Option<&TableInfo> {
        self.schema_graph
            .tables
            .iter()
            .find(|t| t.schema_name == schema && t.table_name == table)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ColumnInfo;

    fn create_test_schema() -> SchemaGraph {
        SchemaGraph {
            tables: vec![
                TableInfo {
                    schema_name: "public".to_string(),
                    table_name: "users".to_string(),
                    estimated_row_count: 1000,
                    columns: vec![ColumnInfo {
                        name: "id".to_string(),
                        data_type: "integer".to_string(),
                        is_nullable: false,
                        is_primary_key: true,
                        default_value: None,
                    }],
                },
                TableInfo {
                    schema_name: "public".to_string(),
                    table_name: "orders".to_string(),
                    estimated_row_count: 5000,
                    columns: vec![
                        ColumnInfo {
                            name: "id".to_string(),
                            data_type: "integer".to_string(),
                            is_nullable: false,
                            is_primary_key: true,
                            default_value: None,
                        },
                        ColumnInfo {
                            name: "user_id".to_string(),
                            data_type: "integer".to_string(),
                            is_nullable: false,
                            is_primary_key: false,
                            default_value: None,
                        },
                    ],
                },
            ],
            foreign_keys: vec![ForeignKey {
                constraint_name: "fk_orders_user".to_string(),
                source_schema: "public".to_string(),
                source_table: "orders".to_string(),
                source_columns: vec!["user_id".to_string()],
                target_schema: "public".to_string(),
                target_table: "users".to_string(),
                target_columns: vec!["id".to_string()],
                on_delete: FkAction::Cascade,
                on_update: FkAction::NoAction,
            }],
        }
    }

    #[test]
    fn test_risk_level_from_score() {
        assert_eq!(RiskLevel::from_score(0), RiskLevel::Low);
        assert_eq!(RiskLevel::from_score(25), RiskLevel::Low);
        assert_eq!(RiskLevel::from_score(26), RiskLevel::Medium);
        assert_eq!(RiskLevel::from_score(50), RiskLevel::Medium);
        assert_eq!(RiskLevel::from_score(51), RiskLevel::High);
        assert_eq!(RiskLevel::from_score(75), RiskLevel::High);
        assert_eq!(RiskLevel::from_score(76), RiskLevel::Critical);
        assert_eq!(RiskLevel::from_score(100), RiskLevel::Critical);
    }

    #[test]
    fn test_table_risk_with_cascade() {
        let schema = create_test_schema();
        let calc = RiskCalculator::new(&schema);

        let risk = calc.calculate_table_risk("public", "users");

        assert!(risk.score > 0);
        assert!(!risk.reasons.is_empty());
        assert!(risk.reasons.iter().any(|r| r.contains("CASCADE")));
    }

    #[test]
    fn test_table_risk_no_references() {
        let schema = create_test_schema();
        let calc = RiskCalculator::new(&schema);

        let risk = calc.calculate_table_risk("public", "orders");

        // orders table has no inbound references
        assert!(risk.score < 50);
    }

    #[test]
    fn test_column_risk_with_references() {
        let schema = create_test_schema();
        let calc = RiskCalculator::new(&schema);

        let risk = calc.calculate_column_risk("public", "users", "id", 100);

        assert!(risk.score > 0);
        assert!(risk.reasons.iter().any(|r| r.contains("reference")));
    }

    #[test]
    fn test_column_risk_primary_key() {
        let schema = create_test_schema();
        let calc = RiskCalculator::new(&schema);

        let risk = calc.calculate_column_risk("public", "users", "id", 0);

        assert!(risk.reasons.iter().any(|r| r.contains("primary key")));
    }
}
