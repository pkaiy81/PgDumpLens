//! Domain models for the DB Viewer service

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Status of a database dump
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[sqlx(type_name = "dump_status", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DumpStatus {
    /// Dump session created, awaiting upload
    Created,
    /// File is being uploaded
    Uploading,
    /// File uploaded, awaiting restore
    Uploaded,
    /// Restore in progress
    Restoring,
    /// Schema introspection in progress
    Analyzing,
    /// Ready for viewing
    Ready,
    /// Error occurred during processing
    Error,
    /// Marked for deletion
    Deleted,
}

impl DumpStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            DumpStatus::Created => "CREATED",
            DumpStatus::Uploading => "UPLOADING",
            DumpStatus::Uploaded => "UPLOADED",
            DumpStatus::Restoring => "RESTORING",
            DumpStatus::Analyzing => "ANALYZING",
            DumpStatus::Ready => "READY",
            DumpStatus::Error => "ERROR",
            DumpStatus::Deleted => "DELETED",
        }
    }
}

/// A database dump entity
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dump {
    /// Unique identifier
    pub id: Uuid,
    /// Human-friendly URL slug
    pub slug: String,
    /// Original filename
    pub original_filename: Option<String>,
    /// Display name
    pub name: Option<String>,
    /// Current status
    pub status: DumpStatus,
    /// Error message if status is Error
    pub error_message: Option<String>,
    /// Size in bytes
    pub file_size: Option<i64>,
    /// Creation timestamp
    pub created_at: DateTime<Utc>,
    /// Last update timestamp
    pub updated_at: DateTime<Utc>,
    /// Expiration timestamp (TTL)
    pub expires_at: DateTime<Utc>,
    /// Sandbox database name
    pub sandbox_db_name: Option<String>,
}

/// Table information from schema introspection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub schema_name: String,
    pub table_name: String,
    pub estimated_row_count: i64,
    pub columns: Vec<ColumnInfo>,
}

/// Column information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub is_primary_key: bool,
    pub default_value: Option<String>,
}

/// Foreign key relationship
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKey {
    pub constraint_name: String,
    pub source_schema: String,
    pub source_table: String,
    pub source_columns: Vec<String>,
    pub target_schema: String,
    pub target_table: String,
    pub target_columns: Vec<String>,
    pub on_delete: FkAction,
    pub on_update: FkAction,
}

/// Foreign key action
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FkAction {
    NoAction,
    Restrict,
    Cascade,
    SetNull,
    SetDefault,
}

impl Default for FkAction {
    fn default() -> Self {
        FkAction::NoAction
    }
}

impl std::fmt::Display for FkAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FkAction::NoAction => write!(f, "NO ACTION"),
            FkAction::Restrict => write!(f, "RESTRICT"),
            FkAction::Cascade => write!(f, "CASCADE"),
            FkAction::SetNull => write!(f, "SET NULL"),
            FkAction::SetDefault => write!(f, "SET DEFAULT"),
        }
    }
}

/// Schema graph containing all relationships
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SchemaGraph {
    pub tables: Vec<TableInfo>,
    pub foreign_keys: Vec<ForeignKey>,
}

/// Relationship direction
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RelationDirection {
    /// This table references another (outbound FK)
    Outbound,
    /// Another table references this (inbound FK)
    Inbound,
}

/// Relationship explanation for a value
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelationExplanation {
    pub source_table: String,
    pub source_column: String,
    pub target_table: String,
    pub target_column: String,
    pub direction: RelationDirection,
    pub path_length: usize,
    pub sample_rows: Vec<serde_json::Value>,
    pub sql_example: String,
    pub risk_score: u8,
    pub risk_reasons: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dump_status_as_str() {
        assert_eq!(DumpStatus::Created.as_str(), "CREATED");
        assert_eq!(DumpStatus::Ready.as_str(), "READY");
        assert_eq!(DumpStatus::Error.as_str(), "ERROR");
    }

    #[test]
    fn test_fk_action_display() {
        assert_eq!(FkAction::Cascade.to_string(), "CASCADE");
        assert_eq!(FkAction::SetNull.to_string(), "SET NULL");
        assert_eq!(FkAction::NoAction.to_string(), "NO ACTION");
    }

    #[test]
    fn test_dump_serialization() {
        let dump = Dump {
            id: Uuid::new_v4(),
            slug: "test-dump".to_string(),
            original_filename: Some("dump.sql".to_string()),
            name: Some("Test Dump".to_string()),
            status: DumpStatus::Ready,
            error_message: None,
            file_size: Some(1024),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            expires_at: Utc::now(),
            sandbox_db_name: Some("sandbox_test".to_string()),
        };

        let json = serde_json::to_string(&dump).unwrap();
        assert!(json.contains("test-dump"));
        assert!(json.contains("READY"));
    }

    #[test]
    fn test_schema_graph_default() {
        let graph = SchemaGraph::default();
        assert!(graph.tables.is_empty());
        assert!(graph.foreign_keys.is_empty());
    }
}
