//! Schema introspection and ER diagram generation

use crate::domain::{ForeignKey, SchemaGraph, TableInfo};
use std::collections::{HashMap, HashSet};

/// Generate Mermaid ER diagram syntax from schema graph
pub fn generate_mermaid_er(schema_graph: &SchemaGraph) -> String {
    let mut output = String::from("erDiagram\n");

    // Generate entity definitions
    for table in &schema_graph.tables {
        let full_name = format!("{}_{}", table.schema_name, table.table_name);
        output.push_str(&format!("    {} {{\n", full_name));
        
        for col in &table.columns {
            let pk_marker = if col.is_primary_key { " PK" } else { "" };
            let nullable = if col.is_nullable { "" } else { " \"NOT NULL\"" };
            output.push_str(&format!(
                "        {} {}{}{}\n",
                col.data_type.replace(' ', "_"),
                col.name,
                pk_marker,
                nullable
            ));
        }
        output.push_str("    }\n");
    }

    // Generate relationships
    for fk in &schema_graph.foreign_keys {
        let source = format!("{}_{}", fk.source_schema, fk.source_table);
        let target = format!("{}_{}", fk.target_schema, fk.target_table);
        
        // Mermaid cardinality notation
        // ||--o{ means one-to-many
        output.push_str(&format!(
            "    {} ||--o{{ {} : \"{}\"\n",
            target, source, fk.constraint_name
        ));
    }

    output
}

/// Find related tables within N hops
pub fn find_related_tables(
    schema_graph: &SchemaGraph,
    schema: &str,
    table: &str,
    max_hops: usize,
) -> Vec<RelatedTable> {
    let mut visited: HashSet<(String, String)> = HashSet::new();
    let mut result: Vec<RelatedTable> = Vec::new();
    let mut queue: Vec<((String, String), usize, Vec<String>)> = Vec::new();

    let start = (schema.to_string(), table.to_string());
    visited.insert(start.clone());
    queue.push((start, 0, vec![]));

    // Build FK lookup maps for efficient traversal
    let mut outbound_fks: HashMap<(String, String), Vec<&ForeignKey>> = HashMap::new();
    let mut inbound_fks: HashMap<(String, String), Vec<&ForeignKey>> = HashMap::new();

    for fk in &schema_graph.foreign_keys {
        let source_key = (fk.source_schema.clone(), fk.source_table.clone());
        let target_key = (fk.target_schema.clone(), fk.target_table.clone());
        
        outbound_fks.entry(source_key).or_default().push(fk);
        inbound_fks.entry(target_key).or_default().push(fk);
    }

    while let Some(((current_schema, current_table), depth, path)) = queue.pop() {
        if depth >= max_hops {
            continue;
        }

        let current_key = (current_schema.clone(), current_table.clone());

        // Follow outbound FKs (this table references another)
        if let Some(fks) = outbound_fks.get(&current_key) {
            for fk in fks {
                let next_key = (fk.target_schema.clone(), fk.target_table.clone());
                if !visited.contains(&next_key) {
                    visited.insert(next_key.clone());
                    let mut new_path = path.clone();
                    new_path.push(fk.constraint_name.clone());
                    
                    result.push(RelatedTable {
                        schema: fk.target_schema.clone(),
                        table: fk.target_table.clone(),
                        relationship: RelationType::ReferencedBy,
                        path: new_path.clone(),
                        hop_count: depth + 1,
                    });
                    
                    queue.push((next_key, depth + 1, new_path));
                }
            }
        }

        // Follow inbound FKs (another table references this)
        if let Some(fks) = inbound_fks.get(&current_key) {
            for fk in fks {
                let next_key = (fk.source_schema.clone(), fk.source_table.clone());
                if !visited.contains(&next_key) {
                    visited.insert(next_key.clone());
                    let mut new_path = path.clone();
                    new_path.push(fk.constraint_name.clone());
                    
                    result.push(RelatedTable {
                        schema: fk.source_schema.clone(),
                        table: fk.source_table.clone(),
                        relationship: RelationType::References,
                        path: new_path.clone(),
                        hop_count: depth + 1,
                    });
                    
                    queue.push((next_key, depth + 1, new_path));
                }
            }
        }
    }

    result
}

/// Related table information
#[derive(Debug, Clone)]
pub struct RelatedTable {
    pub schema: String,
    pub table: String,
    pub relationship: RelationType,
    pub path: Vec<String>,
    pub hop_count: usize,
}

/// Type of relationship
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelationType {
    /// This table references the target
    References,
    /// This table is referenced by the target
    ReferencedBy,
}

/// Filter schema graph by schemas
pub fn filter_by_schemas(schema_graph: &SchemaGraph, schemas: &[&str]) -> SchemaGraph {
    let schema_set: HashSet<&str> = schemas.iter().copied().collect();
    
    let tables: Vec<TableInfo> = schema_graph
        .tables
        .iter()
        .filter(|t| schema_set.contains(t.schema_name.as_str()))
        .cloned()
        .collect();
    
    let table_set: HashSet<(String, String)> = tables
        .iter()
        .map(|t| (t.schema_name.clone(), t.table_name.clone()))
        .collect();
    
    let foreign_keys: Vec<ForeignKey> = schema_graph
        .foreign_keys
        .iter()
        .filter(|fk| {
            table_set.contains(&(fk.source_schema.clone(), fk.source_table.clone()))
                && table_set.contains(&(fk.target_schema.clone(), fk.target_table.clone()))
        })
        .cloned()
        .collect();
    
    SchemaGraph { tables, foreign_keys }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{ColumnInfo, FkAction};

    fn create_test_schema() -> SchemaGraph {
        SchemaGraph {
            tables: vec![
                TableInfo {
                    schema_name: "public".to_string(),
                    table_name: "users".to_string(),
                    estimated_row_count: 100,
                    columns: vec![
                        ColumnInfo {
                            name: "id".to_string(),
                            data_type: "integer".to_string(),
                            is_nullable: false,
                            is_primary_key: true,
                            default_value: None,
                        },
                        ColumnInfo {
                            name: "name".to_string(),
                            data_type: "varchar".to_string(),
                            is_nullable: false,
                            is_primary_key: false,
                            default_value: None,
                        },
                    ],
                },
                TableInfo {
                    schema_name: "public".to_string(),
                    table_name: "orders".to_string(),
                    estimated_row_count: 500,
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
                TableInfo {
                    schema_name: "public".to_string(),
                    table_name: "order_items".to_string(),
                    estimated_row_count: 2000,
                    columns: vec![
                        ColumnInfo {
                            name: "id".to_string(),
                            data_type: "integer".to_string(),
                            is_nullable: false,
                            is_primary_key: true,
                            default_value: None,
                        },
                        ColumnInfo {
                            name: "order_id".to_string(),
                            data_type: "integer".to_string(),
                            is_nullable: false,
                            is_primary_key: false,
                            default_value: None,
                        },
                    ],
                },
            ],
            foreign_keys: vec![
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
                },
                ForeignKey {
                    constraint_name: "fk_order_items_order".to_string(),
                    source_schema: "public".to_string(),
                    source_table: "order_items".to_string(),
                    source_columns: vec!["order_id".to_string()],
                    target_schema: "public".to_string(),
                    target_table: "orders".to_string(),
                    target_columns: vec!["id".to_string()],
                    on_delete: FkAction::Cascade,
                    on_update: FkAction::NoAction,
                },
            ],
        }
    }

    #[test]
    fn test_generate_mermaid_er() {
        let schema = create_test_schema();
        let mermaid = generate_mermaid_er(&schema);

        assert!(mermaid.starts_with("erDiagram"));
        assert!(mermaid.contains("public_users"));
        assert!(mermaid.contains("public_orders"));
        assert!(mermaid.contains("fk_orders_user"));
    }

    #[test]
    fn test_find_related_tables_one_hop() {
        let schema = create_test_schema();
        let related = find_related_tables(&schema, "public", "orders", 1);

        assert_eq!(related.len(), 2);
        
        let table_names: Vec<&str> = related.iter().map(|r| r.table.as_str()).collect();
        assert!(table_names.contains(&"users"));
        assert!(table_names.contains(&"order_items"));
    }

    #[test]
    fn test_find_related_tables_two_hops() {
        let schema = create_test_schema();
        let related = find_related_tables(&schema, "public", "users", 2);

        // Should find orders (1 hop) and order_items (2 hops)
        let table_names: Vec<&str> = related.iter().map(|r| r.table.as_str()).collect();
        assert!(table_names.contains(&"orders"));
        assert!(table_names.contains(&"order_items"));
    }

    #[test]
    fn test_filter_by_schemas() {
        let mut schema = create_test_schema();
        schema.tables.push(TableInfo {
            schema_name: "other".to_string(),
            table_name: "other_table".to_string(),
            estimated_row_count: 10,
            columns: vec![],
        });

        let filtered = filter_by_schemas(&schema, &["public"]);

        assert_eq!(filtered.tables.len(), 3);
        assert!(filtered.tables.iter().all(|t| t.schema_name == "public"));
    }
}
