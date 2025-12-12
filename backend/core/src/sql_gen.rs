//! SQL example generation for relationship exploration

use crate::domain::{ForeignKey, RelationDirection, SchemaGraph};

/// SQL example generator
pub struct SqlGenerator;

impl SqlGenerator {
    /// Generate a SELECT query for rows referencing a value
    pub fn generate_referencing_query(
        fk: &ForeignKey,
        value_placeholder: &str,
        limit: usize,
    ) -> String {
        let source_cols = fk.source_columns.join(", ");
        
        format!(
            r#"-- Rows in {}.{} that reference this value
SELECT *
FROM "{}"."{}" t
WHERE t."{}" = {}
LIMIT {};"#,
            fk.source_schema,
            fk.source_table,
            fk.source_schema,
            fk.source_table,
            fk.source_columns.first().unwrap_or(&"id".to_string()),
            value_placeholder,
            limit
        )
    }

    /// Generate a JOIN query along a relationship path
    pub fn generate_join_query(
        fk: &ForeignKey,
        value_placeholder: &str,
        limit: usize,
    ) -> String {
        format!(
            r#"-- Join preview: {}.{} -> {}.{}
SELECT 
    s.*,
    t.*
FROM "{}"."{}" s
JOIN "{}"."{}" t
    ON t."{}" = s."{}"
WHERE s."{}" = {}
LIMIT {};"#,
            fk.source_schema,
            fk.source_table,
            fk.target_schema,
            fk.target_table,
            fk.source_schema,
            fk.source_table,
            fk.target_schema,
            fk.target_table,
            fk.target_columns.first().unwrap_or(&"id".to_string()),
            fk.source_columns.first().unwrap_or(&"fk_id".to_string()),
            fk.source_columns.first().unwrap_or(&"fk_id".to_string()),
            value_placeholder,
            limit
        )
    }

    /// Generate SQL examples for explaining a relationship
    pub fn generate_relationship_sql(
        schema_graph: &SchemaGraph,
        schema: &str,
        table: &str,
        column: &str,
        direction: RelationDirection,
        value_placeholder: &str,
    ) -> Vec<String> {
        let mut examples = Vec::new();

        match direction {
            RelationDirection::Inbound => {
                // Find FKs where this column is the target
                for fk in &schema_graph.foreign_keys {
                    if fk.target_schema == schema
                        && fk.target_table == table
                        && fk.target_columns.contains(&column.to_string())
                    {
                        examples.push(Self::generate_referencing_query(fk, value_placeholder, 50));
                    }
                }
            }
            RelationDirection::Outbound => {
                // Find FKs where this column is the source
                for fk in &schema_graph.foreign_keys {
                    if fk.source_schema == schema
                        && fk.source_table == table
                        && fk.source_columns.contains(&column.to_string())
                    {
                        examples.push(Self::generate_join_query(fk, value_placeholder, 50));
                    }
                }
            }
        }

        examples
    }

    /// Generate a DELETE impact query
    pub fn generate_delete_impact_query(
        schema: &str,
        table: &str,
        column: &str,
        value_placeholder: &str,
        cascade_fks: &[&ForeignKey],
    ) -> String {
        let mut query = format!(
            r#"-- Impact analysis for deleting from {}.{} where {} = {}
-- This deletion will affect the following tables:
"#,
            schema, table, column, value_placeholder
        );

        for fk in cascade_fks {
            query.push_str(&format!(
                r#"
-- {} rows in {}.{} (ON DELETE {})
SELECT COUNT(*) FROM "{}"."{}" WHERE "{}" = {};
"#,
                fk.on_delete,
                fk.source_schema,
                fk.source_table,
                fk.on_delete,
                fk.source_schema,
                fk.source_table,
                fk.source_columns.first().unwrap_or(&"id".to_string()),
                value_placeholder
            ));
        }

        query
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::FkAction;

    fn create_test_fk() -> ForeignKey {
        ForeignKey {
            constraint_name: "fk_orders_user".to_string(),
            source_schema: "public".to_string(),
            source_table: "orders".to_string(),
            source_columns: vec!["user_id".to_string()],
            target_schema: "public".to_string(),
            target_table: "users".to_string(),
            target_columns: vec!["id".to_string()],
            on_delete: FkAction::Cascade,
            on_update: FkAction::NoAction,
        }
    }

    #[test]
    fn test_generate_referencing_query() {
        let fk = create_test_fk();
        let sql = SqlGenerator::generate_referencing_query(&fk, "$1", 50);

        assert!(sql.contains("SELECT *"));
        assert!(sql.contains("public"));
        assert!(sql.contains("orders"));
        assert!(sql.contains("user_id"));
        assert!(sql.contains("LIMIT 50"));
    }

    #[test]
    fn test_generate_join_query() {
        let fk = create_test_fk();
        let sql = SqlGenerator::generate_join_query(&fk, "$1", 50);

        assert!(sql.contains("JOIN"));
        assert!(sql.contains("public"));
        assert!(sql.contains("orders"));
        assert!(sql.contains("users"));
    }

    #[test]
    fn test_generate_relationship_sql_inbound() {
        let schema_graph = SchemaGraph {
            tables: vec![],
            foreign_keys: vec![create_test_fk()],
        };

        let sqls = SqlGenerator::generate_relationship_sql(
            &schema_graph,
            "public",
            "users",
            "id",
            RelationDirection::Inbound,
            "$1",
        );

        assert_eq!(sqls.len(), 1);
        assert!(sqls[0].contains("orders"));
    }

    #[test]
    fn test_generate_delete_impact_query() {
        let fk = create_test_fk();
        let sql = SqlGenerator::generate_delete_impact_query(
            "public",
            "users",
            "id",
            "$1",
            &[&fk],
        );

        assert!(sql.contains("Impact analysis"));
        assert!(sql.contains("CASCADE"));
        assert!(sql.contains("COUNT(*)"));
    }
}
