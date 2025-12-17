//! Database adapter abstraction for supporting multiple database types

use crate::domain::{ForeignKey, SchemaGraph, TableInfo};
use crate::error::Result;
use async_trait::async_trait;

pub mod postgres;

pub use postgres::PostgresAdapter;

/// Abstract database adapter trait
///
/// This trait defines the interface for interacting with different database systems.
/// Each database type (PostgreSQL, MySQL, etc.) implements this trait.
#[async_trait]
pub trait DbAdapter: Send + Sync {
    /// Restore a dump file into the sandbox database
    /// Returns a list of database names where data was restored
    /// (for pg_dumpall format, multiple databases may be created)
    async fn restore_dump(&self, dump_path: &str, db_name: &str) -> Result<Vec<String>>;

    /// List all tables in the database
    async fn list_tables(&self, db_name: &str) -> Result<Vec<TableInfo>>;

    /// List all foreign keys in the database
    async fn list_foreign_keys(&self, db_name: &str) -> Result<Vec<ForeignKey>>;

    /// Build the complete schema graph
    async fn build_schema_graph(&self, db_name: &str) -> Result<SchemaGraph> {
        let tables = self.list_tables(db_name).await?;
        let foreign_keys = self.list_foreign_keys(db_name).await?;
        Ok(SchemaGraph {
            tables,
            foreign_keys,
        })
    }

    /// Estimate row counts for all tables
    async fn estimate_row_counts(&self, db_name: &str) -> Result<Vec<(String, String, i64)>>;

    /// Fetch sample rows from a table
    async fn fetch_sample_rows(
        &self,
        db_name: &str,
        schema: &str,
        table: &str,
        limit: usize,
    ) -> Result<Vec<serde_json::Value>>;

    /// Drop the sandbox database
    async fn drop_database(&self, db_name: &str) -> Result<()>;

    /// Check if a database exists
    async fn database_exists(&self, db_name: &str) -> Result<bool>;

    /// Create a new database
    async fn create_database(&self, db_name: &str) -> Result<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockall::mock;

    mock! {
        pub TestAdapter {}

        #[async_trait]
        impl DbAdapter for TestAdapter {
            async fn restore_dump(&self, dump_path: &str, db_name: &str) -> Result<Vec<String>>;
            async fn list_tables(&self, db_name: &str) -> Result<Vec<TableInfo>>;
            async fn list_foreign_keys(&self, db_name: &str) -> Result<Vec<ForeignKey>>;
            async fn build_schema_graph(&self, db_name: &str) -> Result<SchemaGraph>;
            async fn estimate_row_counts(&self, db_name: &str) -> Result<Vec<(String, String, i64)>>;
            async fn fetch_sample_rows(
                &self,
                db_name: &str,
                schema: &str,
                table: &str,
                limit: usize,
            ) -> Result<Vec<serde_json::Value>>;
            async fn drop_database(&self, db_name: &str) -> Result<()>;
            async fn database_exists(&self, db_name: &str) -> Result<bool>;
            async fn create_database(&self, db_name: &str) -> Result<()>;
        }
    }

    #[tokio::test]
    async fn test_mock_adapter() {
        let mut mock = MockTestAdapter::new();
        mock.expect_database_exists()
            .with(mockall::predicate::eq("test_db"))
            .returning(|_| Ok(true));

        let result = mock.database_exists("test_db").await;
        assert!(result.unwrap());
    }
}
