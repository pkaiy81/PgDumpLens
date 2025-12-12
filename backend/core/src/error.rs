//! Core error types for the DB Viewer service

use thiserror::Error;

/// Core error type for all operations
#[derive(Error, Debug)]
pub enum CoreError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Dump not found: {0}")]
    DumpNotFound(uuid::Uuid),

    #[error("Table not found: {schema}.{table}")]
    TableNotFound { schema: String, table: String },

    #[error("Invalid dump state: expected {expected}, got {actual}")]
    InvalidDumpState { expected: String, actual: String },

    #[error("Restore failed: {0}")]
    RestoreFailed(String),

    #[error("Schema introspection failed: {0}")]
    IntrospectionFailed(String),

    #[error("Risk calculation error: {0}")]
    RiskCalculation(String),

    #[error("SQL generation error: {0}")]
    SqlGeneration(String),

    #[error("Slug already exists: {0}")]
    SlugExists(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

/// Result type alias using CoreError
pub type Result<T> = std::result::Result<T, CoreError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = CoreError::DumpNotFound(uuid::Uuid::nil());
        assert!(err.to_string().contains("Dump not found"));
    }

    #[test]
    fn test_table_not_found_display() {
        let err = CoreError::TableNotFound {
            schema: "public".to_string(),
            table: "users".to_string(),
        };
        assert_eq!(err.to_string(), "Table not found: public.users");
    }

    #[test]
    fn test_invalid_dump_state_display() {
        let err = CoreError::InvalidDumpState {
            expected: "READY".to_string(),
            actual: "PENDING".to_string(),
        };
        assert!(err.to_string().contains("expected READY, got PENDING"));
    }
}
