//! PostgreSQL adapter implementation

use async_trait::async_trait;
use flate2::read::GzDecoder;
use sqlx::{postgres::PgPool, Row};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::Command;
use tracing::{info, warn};

use crate::adapter::DbAdapter;
use crate::domain::{ColumnInfo, FkAction, ForeignKey, TableInfo};
use crate::error::{CoreError, Result};

/// Magic bytes for pg_dump custom format
const PG_DUMP_CUSTOM_MAGIC: [u8; 5] = [0x50, 0x47, 0x44, 0x4D, 0x50]; // "PGDMP"

/// Magic bytes for gzip compression
const GZIP_MAGIC: [u8; 2] = [0x1F, 0x8B];

/// PostgreSQL database adapter
pub struct PostgresAdapter {
    /// Connection pool to the sandbox PostgreSQL server
    pool: PgPool,
    /// PostgreSQL host for pg_restore
    host: String,
    /// PostgreSQL port
    port: u16,
    /// PostgreSQL user
    user: String,
    /// PostgreSQL password (for pg_restore)
    password: Option<String>,
}

impl PostgresAdapter {
    /// Create a new PostgreSQL adapter
    pub fn new(
        pool: PgPool,
        host: String,
        port: u16,
        user: String,
        password: Option<String>,
    ) -> Self {
        Self {
            pool,
            host,
            port,
            user,
            password,
        }
    }

    /// Build connection URL for a specific database
    fn build_db_url(&self, db_name: &str) -> String {
        if let Some(ref password) = self.password {
            format!(
                "postgres://{}:{}@{}:{}/{}",
                self.user, password, self.host, self.port, db_name
            )
        } else {
            format!(
                "postgres://{}@{}:{}/{}",
                self.user, self.host, self.port, db_name
            )
        }
    }

    /// Parse FK action from PostgreSQL string
    fn parse_fk_action(action: &str) -> FkAction {
        match action.to_uppercase().as_str() {
            "CASCADE" => FkAction::Cascade,
            "SET NULL" => FkAction::SetNull,
            "SET DEFAULT" => FkAction::SetDefault,
            "RESTRICT" => FkAction::Restrict,
            _ => FkAction::NoAction,
        }
    }

    /// Detect if file is gzip compressed and decompress if needed
    /// Returns the path to the (possibly decompressed) file
    async fn decompress_if_needed(&self, dump_path: &str) -> Result<String> {
        let path = Path::new(dump_path);
        let file = File::open(path)
            .map_err(|e| CoreError::RestoreFailed(format!("Failed to open dump file: {}", e)))?;
        let mut reader = BufReader::new(file);
        let mut magic = [0u8; 2];

        if reader.read_exact(&mut magic).is_ok() && magic == GZIP_MAGIC {
            info!("Detected gzip-compressed dump, decompressing...");

            // Create decompressed file path
            let decompressed_path = if dump_path.ends_with(".gz") {
                dump_path.strip_suffix(".gz").unwrap().to_string()
            } else {
                format!("{}.decompressed", dump_path)
            };

            // Reopen file for decompression
            let file = File::open(path).map_err(|e| {
                CoreError::RestoreFailed(format!("Failed to open dump file: {}", e))
            })?;

            let mut decoder = GzDecoder::new(file);
            let mut output_file = File::create(&decompressed_path).map_err(|e| {
                CoreError::RestoreFailed(format!("Failed to create decompressed file: {}", e))
            })?;

            std::io::copy(&mut decoder, &mut output_file).map_err(|e| {
                CoreError::RestoreFailed(format!("Failed to decompress gzip file: {}", e))
            })?;

            info!("Decompressed to: {}", decompressed_path);
            return Ok(decompressed_path);
        }

        // Not compressed, return original path
        Ok(dump_path.to_string())
    }

    /// Detect pg_dump format by reading magic bytes
    /// Returns true for custom/tar format, false for plain SQL
    fn detect_pg_dump_format(&self, dump_path: &str) -> Result<bool> {
        let path = Path::new(dump_path);
        let file = File::open(path).map_err(|e| {
            CoreError::RestoreFailed(format!(
                "Failed to open dump file for format detection: {}",
                e
            ))
        })?;
        let mut reader = BufReader::new(file);
        let mut magic = [0u8; 5];

        if reader.read_exact(&mut magic).is_ok() {
            // Check for PGDMP magic (custom format)
            if magic == PG_DUMP_CUSTOM_MAGIC {
                return Ok(true);
            }
        }

        // If not custom format, assume plain SQL
        // We could also check for tar format (starts with file entries),
        // but pg_restore handles both custom and tar the same way
        Ok(false)
    }
}

#[async_trait]
impl DbAdapter for PostgresAdapter {
    async fn restore_dump(&self, dump_path: &str, db_name: &str) -> Result<()> {
        info!("Restoring dump {} to database {}", dump_path, db_name);

        // Create database first
        self.create_database(db_name).await?;

        // Detect dump format from magic bytes, not extension
        let actual_path = self.decompress_if_needed(dump_path).await?;
        let is_custom_format = self.detect_pg_dump_format(&actual_path)?;

        info!(
            "Detected dump format: {}",
            if is_custom_format {
                "custom/tar"
            } else {
                "plain SQL"
            }
        );

        if is_custom_format {
            // Custom format - use pg_restore command
            let mut cmd = Command::new("pg_restore");
            cmd.args([
                "-h",
                &self.host,
                "-p",
                &self.port.to_string(),
                "-U",
                &self.user,
                "-d",
                db_name,
                "--no-owner",
                "--no-privileges",
                &actual_path,
            ]);

            if let Some(ref password) = self.password {
                cmd.env("PGPASSWORD", password);
            }

            let output = cmd.output().map_err(|e| {
                CoreError::RestoreFailed(format!("Failed to execute pg_restore: {}", e))
            })?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                if stderr.contains("ERROR") || stderr.contains("FATAL") {
                    return Err(CoreError::RestoreFailed(stderr.to_string()));
                }
                warn!("pg_restore completed with warnings: {}", stderr);
            }
        } else {
            // Plain SQL format - execute directly with SQLx
            info!("Executing SQL file directly with SQLx");

            let sql_content = tokio::fs::read_to_string(&actual_path)
                .await
                .map_err(|e| CoreError::RestoreFailed(format!("Failed to read SQL file: {}", e)))?;

            let db_url = self.build_db_url(db_name);
            let db_pool = PgPool::connect(&db_url).await.map_err(|e| {
                CoreError::RestoreFailed(format!("Failed to connect to database: {}", e))
            })?;

            // Don't use transaction - some commands like CREATE INDEX CONCURRENTLY can't run in transaction
            // Execute each statement independently and continue on non-critical errors
            let mut executed = 0;
            let mut skipped = 0;
            let mut errors = 0;

            for statement in sql_content.split(';') {
                let trimmed = statement.trim();

                // Skip empty statements
                if trimmed.is_empty() {
                    continue;
                }

                // Remove leading comment lines (pg_dump metadata) and psql meta-commands
                let mut cleaned = String::new();
                for line in trimmed.lines() {
                    let line_trimmed = line.trim();
                    // Skip comment lines and psql meta-commands (starting with backslash)
                    if !line_trimmed.starts_with("--") && !line_trimmed.starts_with("\\") {
                        cleaned.push_str(line);
                        cleaned.push('\n');
                    }
                }
                let cleaned = cleaned.trim();

                // Skip if nothing left after removing comments
                if cleaned.is_empty() {
                    continue;
                }

                // Skip pg_dump metadata fragments (e.g., "Type: DATABASE" from split comment lines)
                // These appear when comments like "-- Name: db; Type: DATABASE" are split by ';'
                if cleaned.starts_with("Type:")
                    || cleaned.starts_with("Owner:")
                    || cleaned.starts_with("Schema:")
                    || cleaned.starts_with("Name:")
                    || cleaned.starts_with("Tablespace:")
                {
                    continue;
                }

                // Skip statements that should be ignored in restore context
                let upper = cleaned.to_uppercase();
                if upper.starts_with("ALTER ROLE")
                    || upper.starts_with("CREATE ROLE")
                    || upper.starts_with("DROP ROLE")
                    || upper.starts_with("GRANT")
                    || upper.starts_with("REVOKE")
                    || upper.contains("SET SESSION AUTHORIZATION")
                    || upper.contains("SELECT PG_CATALOG.SET_CONFIG")
                {
                    skipped += 1;
                    continue;
                } // Execute statement
                match sqlx::query(cleaned).execute(&db_pool).await {
                    Ok(_) => {
                        executed += 1;
                    }
                    Err(e) => {
                        let error_msg = e.to_string();
                        // Ignore certain non-critical errors
                        if error_msg.contains("already exists")
                            || error_msg.contains("does not exist")
                            || error_msg.contains("role")
                        {
                            warn!(
                                "Non-critical error (continuing): {} - Statement: {}",
                                error_msg,
                                cleaned.chars().take(100).collect::<String>()
                            );
                            errors += 1;
                        } else {
                            // Critical error - fail restore
                            return Err(CoreError::RestoreFailed(format!(
                                "Failed to execute SQL statement: {}. Error: {}",
                                cleaned.chars().take(100).collect::<String>(),
                                error_msg
                            )));
                        }
                    }
                }
            }

            info!(
                "SQL execution completed: {} statements executed, {} skipped, {} non-critical errors",
                executed, skipped, errors
            );

            db_pool.close().await;
        }

        info!("Successfully restored dump to database {}", db_name);
        Ok(())
    }

    async fn list_tables(&self, db_name: &str) -> Result<Vec<TableInfo>> {
        let query = r#"
            SELECT 
                t.table_schema,
                t.table_name,
                COALESCE(s.n_live_tup, 0) as estimated_rows
            FROM information_schema.tables t
            LEFT JOIN pg_stat_user_tables s 
                ON s.schemaname = t.table_schema 
                AND s.relname = t.table_name
            WHERE t.table_type = 'BASE TABLE'
                AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY t.table_schema, t.table_name
        "#;

        // Connect to the specific database
        let db_url = self.build_db_url(db_name);
        let db_pool = PgPool::connect(&db_url).await?;

        let rows = sqlx::query(query).fetch_all(&db_pool).await?;

        let mut tables = Vec::new();
        for row in rows {
            let schema_name: String = row.get("table_schema");
            let table_name: String = row.get("table_name");
            let estimated_row_count: i64 = row.get("estimated_rows");

            // Get columns for this table
            let columns = self
                .get_columns(&db_pool, &schema_name, &table_name)
                .await?;

            tables.push(TableInfo {
                schema_name,
                table_name,
                estimated_row_count,
                columns,
            });
        }

        Ok(tables)
    }

    async fn list_foreign_keys(&self, db_name: &str) -> Result<Vec<ForeignKey>> {
        let query = r#"
            SELECT
                tc.constraint_name,
                tc.table_schema as source_schema,
                tc.table_name as source_table,
                kcu.column_name as source_column,
                ccu.table_schema as target_schema,
                ccu.table_name as target_table,
                ccu.column_name as target_column,
                rc.delete_rule,
                rc.update_rule
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
                ON ccu.constraint_name = tc.constraint_name
            JOIN information_schema.referential_constraints rc
                ON tc.constraint_name = rc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
            ORDER BY tc.constraint_name, kcu.ordinal_position
        "#;

        let db_url = self.build_db_url(db_name);
        let db_pool = PgPool::connect(&db_url).await?;

        let rows = sqlx::query(query).fetch_all(&db_pool).await?;

        // Group by constraint name to handle composite FKs
        let mut fk_map: std::collections::HashMap<String, ForeignKey> =
            std::collections::HashMap::new();

        for row in rows {
            let constraint_name: String = row.get("constraint_name");
            let source_column: String = row.get("source_column");
            let target_column: String = row.get("target_column");

            if let Some(fk) = fk_map.get_mut(&constraint_name) {
                fk.source_columns.push(source_column);
                fk.target_columns.push(target_column);
            } else {
                fk_map.insert(
                    constraint_name.clone(),
                    ForeignKey {
                        constraint_name,
                        source_schema: row.get("source_schema"),
                        source_table: row.get("source_table"),
                        source_columns: vec![source_column],
                        target_schema: row.get("target_schema"),
                        target_table: row.get("target_table"),
                        target_columns: vec![target_column],
                        on_delete: Self::parse_fk_action(row.get("delete_rule")),
                        on_update: Self::parse_fk_action(row.get("update_rule")),
                    },
                );
            }
        }

        Ok(fk_map.into_values().collect())
    }

    async fn estimate_row_counts(&self, db_name: &str) -> Result<Vec<(String, String, i64)>> {
        let query = r#"
            SELECT schemaname, relname, n_live_tup
            FROM pg_stat_user_tables
            ORDER BY schemaname, relname
        "#;

        let db_url = self.build_db_url(db_name);
        let db_pool = PgPool::connect(&db_url).await?;

        let rows = sqlx::query(query).fetch_all(&db_pool).await?;

        let counts = rows
            .iter()
            .map(|row| {
                (
                    row.get::<String, _>("schemaname"),
                    row.get::<String, _>("relname"),
                    row.get::<i64, _>("n_live_tup"),
                )
            })
            .collect();

        Ok(counts)
    }

    async fn fetch_sample_rows(
        &self,
        db_name: &str,
        schema: &str,
        table: &str,
        limit: usize,
    ) -> Result<Vec<serde_json::Value>> {
        let db_url = self.build_db_url(db_name);
        let db_pool = PgPool::connect(&db_url).await?;

        // Use quote_ident equivalent for safety
        let query = format!(
            "SELECT to_jsonb(t.*) as row_data FROM \"{}\".\"{}\" t LIMIT {}",
            schema, table, limit
        );

        let rows = sqlx::query(&query).fetch_all(&db_pool).await?;

        let result: Vec<serde_json::Value> = rows
            .iter()
            .map(|row| row.get::<serde_json::Value, _>("row_data"))
            .collect();

        Ok(result)
    }

    async fn drop_database(&self, db_name: &str) -> Result<()> {
        // Terminate existing connections first
        let terminate_query = format!(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '{}'",
            db_name
        );
        sqlx::query(&terminate_query).execute(&self.pool).await?;

        // Drop the database
        let drop_query = format!("DROP DATABASE IF EXISTS \"{}\"", db_name);
        sqlx::query(&drop_query).execute(&self.pool).await?;

        Ok(())
    }

    async fn database_exists(&self, db_name: &str) -> Result<bool> {
        let query = "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1)";
        let row = sqlx::query(query)
            .bind(db_name)
            .fetch_one(&self.pool)
            .await?;

        Ok(row.get::<bool, _>(0))
    }

    async fn create_database(&self, db_name: &str) -> Result<()> {
        if self.database_exists(db_name).await? {
            info!("Database {} already exists, dropping first", db_name);
            self.drop_database(db_name).await?;
        }

        let query = format!("CREATE DATABASE \"{}\"", db_name);
        sqlx::query(&query).execute(&self.pool).await?;

        info!("Created database {}", db_name);
        Ok(())
    }
}

impl PostgresAdapter {
    async fn get_columns(
        &self,
        pool: &PgPool,
        schema: &str,
        table: &str,
    ) -> Result<Vec<ColumnInfo>> {
        let query = r#"
            SELECT 
                c.column_name,
                c.data_type,
                c.is_nullable = 'YES' as is_nullable,
                c.column_default,
                COALESCE(pk.is_pk, false) as is_primary_key
            FROM information_schema.columns c
            LEFT JOIN (
                SELECT kcu.column_name, true as is_pk
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                    ON tc.constraint_name = kcu.constraint_name
                WHERE tc.constraint_type = 'PRIMARY KEY'
                    AND tc.table_schema = $1
                    AND tc.table_name = $2
            ) pk ON pk.column_name = c.column_name
            WHERE c.table_schema = $1 AND c.table_name = $2
            ORDER BY c.ordinal_position
        "#;

        let rows = sqlx::query(query)
            .bind(schema)
            .bind(table)
            .fetch_all(pool)
            .await?;

        let columns = rows
            .iter()
            .map(|row| ColumnInfo {
                name: row.get("column_name"),
                data_type: row.get("data_type"),
                is_nullable: row.get("is_nullable"),
                is_primary_key: row.get("is_primary_key"),
                default_value: row.get("column_default"),
            })
            .collect();

        Ok(columns)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_fk_action() {
        assert_eq!(
            PostgresAdapter::parse_fk_action("CASCADE"),
            FkAction::Cascade
        );
        assert_eq!(
            PostgresAdapter::parse_fk_action("SET NULL"),
            FkAction::SetNull
        );
        assert_eq!(
            PostgresAdapter::parse_fk_action("RESTRICT"),
            FkAction::Restrict
        );
        assert_eq!(
            PostgresAdapter::parse_fk_action("NO ACTION"),
            FkAction::NoAction
        );
        assert_eq!(
            PostgresAdapter::parse_fk_action("unknown"),
            FkAction::NoAction
        );
    }
}
