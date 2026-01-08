//! Schema and data diff comparison logic

use crate::domain::{ColumnInfo, ForeignKey, SchemaGraph, TableInfo};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Type of change detected
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeType {
    Added,
    Removed,
    Modified,
}

/// Summary of differences between two dumps
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiffSummary {
    /// Total number of tables added
    pub tables_added: usize,
    /// Total number of tables removed
    pub tables_removed: usize,
    /// Total number of tables modified
    pub tables_modified: usize,
    /// Total number of columns added
    pub columns_added: usize,
    /// Total number of columns removed
    pub columns_removed: usize,
    /// Total number of columns modified
    pub columns_modified: usize,
    /// Total number of foreign keys added
    pub fk_added: usize,
    /// Total number of foreign keys removed
    pub fk_removed: usize,
    /// Net change in total row count
    pub row_count_change: i64,
}

/// Difference in a table
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDiff {
    pub schema_name: String,
    pub table_name: String,
    pub change_type: ChangeType,
    /// Row count in base dump (None if table was added)
    pub base_row_count: Option<i64>,
    /// Row count in compare dump (None if table was removed)
    pub compare_row_count: Option<i64>,
    /// Column differences (only for modified tables)
    pub column_diffs: Vec<ColumnDiff>,
    /// Whether this table has data changes (row count difference)
    #[serde(default)]
    pub has_data_change: bool,
}

/// Difference in a column
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnDiff {
    pub column_name: String,
    pub change_type: ChangeType,
    /// Base column info (None if column was added)
    pub base_info: Option<ColumnDiffInfo>,
    /// Compare column info (None if column was removed)
    pub compare_info: Option<ColumnDiffInfo>,
}

/// Column information for diff display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnDiffInfo {
    pub data_type: String,
    pub is_nullable: bool,
    pub is_primary_key: bool,
    pub default_value: Option<String>,
}

impl From<&ColumnInfo> for ColumnDiffInfo {
    fn from(col: &ColumnInfo) -> Self {
        Self {
            data_type: col.data_type.clone(),
            is_nullable: col.is_nullable,
            is_primary_key: col.is_primary_key,
            default_value: col.default_value.clone(),
        }
    }
}

/// Difference in a foreign key
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKeyDiff {
    pub constraint_name: String,
    pub change_type: ChangeType,
    pub source_table: String,
    pub target_table: String,
    /// Full FK info for added/removed
    pub fk_info: Option<ForeignKey>,
}

/// Complete diff result between two schema graphs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaDiff {
    pub summary: DiffSummary,
    pub table_diffs: Vec<TableDiff>,
    pub fk_diffs: Vec<ForeignKeyDiff>,
}

/// Row-level diff for a specific table
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDataDiff {
    pub schema_name: String,
    pub table_name: String,
    pub primary_key_columns: Vec<String>,
    pub rows_added: usize,
    pub rows_removed: usize,
    pub rows_modified: usize,
    /// Sample of added rows (limited)
    pub sample_added: Vec<serde_json::Value>,
    /// Sample of removed rows (limited)
    pub sample_removed: Vec<serde_json::Value>,
    /// Sample of modified rows with before/after (limited)
    pub sample_modified: Vec<RowModification>,
}

/// A single row modification
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowModification {
    pub primary_key: serde_json::Value,
    pub before: serde_json::Value,
    pub after: serde_json::Value,
    pub changed_columns: Vec<String>,
}

/// Compare two schema graphs and return differences
pub fn compare_schemas(base: &SchemaGraph, compare: &SchemaGraph) -> SchemaDiff {
    let mut summary = DiffSummary::default();
    let mut table_diffs = Vec::new();
    let mut fk_diffs = Vec::new();

    // Build lookup maps
    let base_tables: HashMap<(&str, &str), &TableInfo> = base
        .tables
        .iter()
        .map(|t| ((t.schema_name.as_str(), t.table_name.as_str()), t))
        .collect();

    let compare_tables: HashMap<(&str, &str), &TableInfo> = compare
        .tables
        .iter()
        .map(|t| ((t.schema_name.as_str(), t.table_name.as_str()), t))
        .collect();

    let base_keys: HashSet<_> = base_tables.keys().cloned().collect();
    let compare_keys: HashSet<_> = compare_tables.keys().cloned().collect();

    // Find added tables
    for key in compare_keys.difference(&base_keys) {
        let table = compare_tables[key];
        summary.tables_added += 1;
        summary.columns_added += table.columns.len();
        summary.row_count_change += table.estimated_row_count;

        table_diffs.push(TableDiff {
            schema_name: table.schema_name.clone(),
            table_name: table.table_name.clone(),
            change_type: ChangeType::Added,
            base_row_count: None,
            compare_row_count: Some(table.estimated_row_count),
            column_diffs: table
                .columns
                .iter()
                .map(|c| ColumnDiff {
                    column_name: c.name.clone(),
                    change_type: ChangeType::Added,
                    base_info: None,
                    compare_info: Some(c.into()),
                })
                .collect(),
            has_data_change: true,
        });
    }

    // Find removed tables
    for key in base_keys.difference(&compare_keys) {
        let table = base_tables[key];
        summary.tables_removed += 1;
        summary.columns_removed += table.columns.len();
        summary.row_count_change -= table.estimated_row_count;

        table_diffs.push(TableDiff {
            schema_name: table.schema_name.clone(),
            table_name: table.table_name.clone(),
            change_type: ChangeType::Removed,
            base_row_count: Some(table.estimated_row_count),
            compare_row_count: None,
            column_diffs: table
                .columns
                .iter()
                .map(|c| ColumnDiff {
                    column_name: c.name.clone(),
                    change_type: ChangeType::Removed,
                    base_info: Some(c.into()),
                    compare_info: None,
                })
                .collect(),
            has_data_change: true,
        });
    }

    // Find modified tables and unchanged tables
    for key in base_keys.intersection(&compare_keys) {
        let base_table = base_tables[key];
        let compare_table = compare_tables[key];

        let column_diffs = compare_columns(&base_table.columns, &compare_table.columns);

        let row_diff = compare_table.estimated_row_count - base_table.estimated_row_count;
        summary.row_count_change += row_diff;

        let has_data_change = row_diff != 0;

        // Count column changes
        for cd in &column_diffs {
            match cd.change_type {
                ChangeType::Added => summary.columns_added += 1,
                ChangeType::Removed => summary.columns_removed += 1,
                ChangeType::Modified => summary.columns_modified += 1,
            }
        }

        // Only include tables that have actual changes (schema or data)
        // Skip tables with no changes at all
        if column_diffs.is_empty() && !has_data_change {
            continue;
        }

        // Count as "modified" if there are schema changes
        if !column_diffs.is_empty() {
            summary.tables_modified += 1;
        }

        table_diffs.push(TableDiff {
            schema_name: base_table.schema_name.clone(),
            table_name: base_table.table_name.clone(),
            change_type: ChangeType::Modified,
            base_row_count: Some(base_table.estimated_row_count),
            compare_row_count: Some(compare_table.estimated_row_count),
            column_diffs,
            has_data_change,
        });
    }

    // Compare foreign keys
    let base_fks: HashMap<&str, &ForeignKey> = base
        .foreign_keys
        .iter()
        .map(|fk| (fk.constraint_name.as_str(), fk))
        .collect();

    let compare_fks: HashMap<&str, &ForeignKey> = compare
        .foreign_keys
        .iter()
        .map(|fk| (fk.constraint_name.as_str(), fk))
        .collect();

    let base_fk_names: HashSet<_> = base_fks.keys().cloned().collect();
    let compare_fk_names: HashSet<_> = compare_fks.keys().cloned().collect();

    // Added FKs
    for name in compare_fk_names.difference(&base_fk_names) {
        let fk = compare_fks[name];
        summary.fk_added += 1;
        fk_diffs.push(ForeignKeyDiff {
            constraint_name: fk.constraint_name.clone(),
            change_type: ChangeType::Added,
            source_table: format!("{}.{}", fk.source_schema, fk.source_table),
            target_table: format!("{}.{}", fk.target_schema, fk.target_table),
            fk_info: Some(fk.clone()),
        });
    }

    // Removed FKs
    for name in base_fk_names.difference(&compare_fk_names) {
        let fk = base_fks[name];
        summary.fk_removed += 1;
        fk_diffs.push(ForeignKeyDiff {
            constraint_name: fk.constraint_name.clone(),
            change_type: ChangeType::Removed,
            source_table: format!("{}.{}", fk.source_schema, fk.source_table),
            target_table: format!("{}.{}", fk.target_schema, fk.target_table),
            fk_info: Some(fk.clone()),
        });
    }

    // Sort diffs for consistent output
    table_diffs
        .sort_by(|a, b| (&a.schema_name, &a.table_name).cmp(&(&b.schema_name, &b.table_name)));
    fk_diffs.sort_by(|a, b| a.constraint_name.cmp(&b.constraint_name));

    SchemaDiff {
        summary,
        table_diffs,
        fk_diffs,
    }
}

/// Compare columns between two tables
fn compare_columns(base: &[ColumnInfo], compare: &[ColumnInfo]) -> Vec<ColumnDiff> {
    let mut diffs = Vec::new();

    let base_cols: HashMap<&str, &ColumnInfo> = base.iter().map(|c| (c.name.as_str(), c)).collect();
    let compare_cols: HashMap<&str, &ColumnInfo> =
        compare.iter().map(|c| (c.name.as_str(), c)).collect();

    let base_names: HashSet<_> = base_cols.keys().cloned().collect();
    let compare_names: HashSet<_> = compare_cols.keys().cloned().collect();

    // Added columns
    for name in compare_names.difference(&base_names) {
        let col = compare_cols[name];
        diffs.push(ColumnDiff {
            column_name: col.name.clone(),
            change_type: ChangeType::Added,
            base_info: None,
            compare_info: Some(col.into()),
        });
    }

    // Removed columns
    for name in base_names.difference(&compare_names) {
        let col = base_cols[name];
        diffs.push(ColumnDiff {
            column_name: col.name.clone(),
            change_type: ChangeType::Removed,
            base_info: Some(col.into()),
            compare_info: None,
        });
    }

    // Modified columns
    for name in base_names.intersection(&compare_names) {
        let base_col = base_cols[name];
        let compare_col = compare_cols[name];

        if is_column_modified(base_col, compare_col) {
            diffs.push(ColumnDiff {
                column_name: base_col.name.clone(),
                change_type: ChangeType::Modified,
                base_info: Some(base_col.into()),
                compare_info: Some(compare_col.into()),
            });
        }
    }

    diffs.sort_by(|a, b| a.column_name.cmp(&b.column_name));
    diffs
}

/// Check if a column has been modified
fn is_column_modified(base: &ColumnInfo, compare: &ColumnInfo) -> bool {
    base.data_type != compare.data_type
        || base.is_nullable != compare.is_nullable
        || base.is_primary_key != compare.is_primary_key
        || base.default_value != compare.default_value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_column(name: &str, data_type: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            is_nullable: true,
            is_primary_key: false,
            default_value: None,
        }
    }

    fn make_table(schema: &str, name: &str, columns: Vec<ColumnInfo>, rows: i64) -> TableInfo {
        TableInfo {
            schema_name: schema.to_string(),
            table_name: name.to_string(),
            estimated_row_count: rows,
            columns,
        }
    }

    #[test]
    fn test_compare_schemas_added_table() {
        let base = SchemaGraph {
            tables: vec![make_table(
                "public",
                "users",
                vec![make_column("id", "bigint")],
                100,
            )],
            foreign_keys: vec![],
        };

        let compare = SchemaGraph {
            tables: vec![
                make_table("public", "users", vec![make_column("id", "bigint")], 100),
                make_table("public", "orders", vec![make_column("id", "bigint")], 50),
            ],
            foreign_keys: vec![],
        };

        let diff = compare_schemas(&base, &compare);

        assert_eq!(diff.summary.tables_added, 1);
        assert_eq!(diff.summary.tables_removed, 0);
        assert_eq!(diff.summary.row_count_change, 50);
    }

    #[test]
    fn test_compare_schemas_removed_table() {
        let base = SchemaGraph {
            tables: vec![
                make_table("public", "users", vec![make_column("id", "bigint")], 100),
                make_table("public", "old_table", vec![make_column("id", "bigint")], 30),
            ],
            foreign_keys: vec![],
        };

        let compare = SchemaGraph {
            tables: vec![make_table(
                "public",
                "users",
                vec![make_column("id", "bigint")],
                100,
            )],
            foreign_keys: vec![],
        };

        let diff = compare_schemas(&base, &compare);

        assert_eq!(diff.summary.tables_added, 0);
        assert_eq!(diff.summary.tables_removed, 1);
        assert_eq!(diff.summary.row_count_change, -30);
    }

    #[test]
    fn test_compare_columns_added() {
        let base = vec![make_column("id", "bigint")];
        let compare = vec![make_column("id", "bigint"), make_column("email", "varchar")];

        let diffs = compare_columns(&base, &compare);

        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].column_name, "email");
        assert_eq!(diffs[0].change_type, ChangeType::Added);
    }

    #[test]
    fn test_compare_columns_modified() {
        let base = vec![ColumnInfo {
            name: "status".to_string(),
            data_type: "varchar(50)".to_string(),
            is_nullable: true,
            is_primary_key: false,
            default_value: None,
        }];

        let compare = vec![ColumnInfo {
            name: "status".to_string(),
            data_type: "varchar(100)".to_string(), // Changed
            is_nullable: false,                    // Changed
            is_primary_key: false,
            default_value: Some("'active'".to_string()), // Added
        }];

        let diffs = compare_columns(&base, &compare);

        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].change_type, ChangeType::Modified);
    }
}
