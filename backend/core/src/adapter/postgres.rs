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

    /// Detect if dump is from pg_dumpall (cluster dump) and extract database names
    /// Returns a list of database names that will be created by the dump
    fn detect_pg_dumpall_databases(&self, dump_path: &str) -> Result<Vec<String>> {
        use std::io::BufRead;

        let path = Path::new(dump_path);
        let file = File::open(path)
            .map_err(|e| CoreError::RestoreFailed(format!("Failed to open dump file: {}", e)))?;
        let reader = BufReader::new(file);

        let mut databases = Vec::new();
        let mut is_pg_dumpall = false;

        // Check first 100 lines for pg_dumpall signatures
        for line in reader.lines().take(100).map_while(|r| r.ok()) {
            // pg_dumpall typically has "database cluster dump" comment
            if line.contains("database cluster dump") {
                is_pg_dumpall = true;
            }
            // Check for CREATE ROLE statements (another pg_dumpall signature)
            if line.starts_with("CREATE ROLE") {
                is_pg_dumpall = true;
            }
        }

        if !is_pg_dumpall {
            return Ok(databases);
        }

        // Re-read file to find all CREATE DATABASE statements
        let file = File::open(path)
            .map_err(|e| CoreError::RestoreFailed(format!("Failed to open dump file: {}", e)))?;
        let reader = BufReader::new(file);

        for line in reader.lines().map_while(|r| r.ok()) {
            // Match: CREATE DATABASE dbname WITH ...
            if line.starts_with("CREATE DATABASE ") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 {
                    let db_name = parts[2].trim_end_matches(';');
                    // Skip template databases
                    if db_name != "template0" && db_name != "template1" && db_name != "postgres" {
                        databases.push(db_name.to_string());
                    }
                }
            }
        }

        info!("Detected pg_dumpall format with databases: {:?}", databases);
        Ok(databases)
    }

    /// Rewrite pg_dumpall SQL to rename databases with a prefix
    /// This allows multiple pg_dumpall dumps to coexist in the sandbox
    fn rewrite_pg_dumpall_with_prefix(
        &self,
        dump_path: &str,
        prefix: &str,
    ) -> Result<(String, Vec<String>)> {
        use std::io::{BufRead, Write};

        let path = Path::new(dump_path);
        let file = File::open(path)
            .map_err(|e| CoreError::RestoreFailed(format!("Failed to open dump file: {}", e)))?;
        let reader = BufReader::new(file);

        // Output file with rewritten content
        let rewritten_path = format!("{}.rewritten", dump_path);
        let mut output = File::create(&rewritten_path).map_err(|e| {
            CoreError::RestoreFailed(format!("Failed to create rewritten dump: {}", e))
        })?;

        let mut databases = Vec::new();
        let mut db_name_map: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        // First pass: identify database names
        for line in reader.lines().map_while(|r| r.ok()) {
            if line.starts_with("CREATE DATABASE ") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 {
                    let original_name = parts[2].trim_end_matches(';').to_string();
                    if original_name != "template0"
                        && original_name != "template1"
                        && original_name != "postgres"
                    {
                        let new_name = format!("{}_{}", prefix, original_name);
                        db_name_map.insert(original_name, new_name);
                    }
                }
            }
        }

        // Build prefixed database list
        for new_name in db_name_map.values() {
            databases.push(new_name.clone());
        }

        // Second pass: rewrite the dump
        let file = File::open(path)
            .map_err(|e| CoreError::RestoreFailed(format!("Failed to open dump file: {}", e)))?;
        let reader = BufReader::new(file);

        for line in reader.lines() {
            let line =
                line.map_err(|e| CoreError::RestoreFailed(format!("Failed to read line: {}", e)))?;

            let mut rewritten_line = line.clone();

            // Rewrite CREATE DATABASE statements
            if line.starts_with("CREATE DATABASE ") {
                for (original, prefixed) in &db_name_map {
                    // Match exact database name (avoiding partial matches)
                    let pattern = format!("CREATE DATABASE {} ", original);
                    let replacement = format!("CREATE DATABASE {} ", prefixed);
                    rewritten_line = rewritten_line.replace(&pattern, &replacement);

                    let pattern = format!("CREATE DATABASE {};", original);
                    let replacement = format!("CREATE DATABASE {};", prefixed);
                    rewritten_line = rewritten_line.replace(&pattern, &replacement);
                }
            }

            // Rewrite \connect statements
            if line.starts_with("\\connect ") {
                for (original, prefixed) in &db_name_map {
                    let pattern = format!("\\connect {}", original);
                    let replacement = format!("\\connect {}", prefixed);
                    rewritten_line = rewritten_line.replace(&pattern, &replacement);
                }
            }

            // Rewrite GRANT/REVOKE ON DATABASE statements
            if (line.contains("ON DATABASE") || line.contains("DATABASE "))
                && (line.starts_with("GRANT")
                    || line.starts_with("REVOKE")
                    || line.starts_with("ALTER DATABASE"))
            {
                for (original, prefixed) in &db_name_map {
                    rewritten_line = rewritten_line
                        .replace(&format!(" {} ", original), &format!(" {} ", prefixed));
                    rewritten_line = rewritten_line
                        .replace(&format!(" {};", original), &format!(" {};", prefixed));
                }
            }

            writeln!(output, "{}", rewritten_line).map_err(|e| {
                CoreError::RestoreFailed(format!("Failed to write rewritten dump: {}", e))
            })?;
        }

        info!(
            "Rewrote pg_dumpall with prefix '{}', databases: {:?}",
            prefix, databases
        );
        Ok((rewritten_path, databases))
    }

    /// Extract table names from a dump file without restoring it
    /// Returns a list of (schema_name, table_name, estimated_size_bytes) tuples
    pub fn extract_tables_from_dump(&self, dump_path: &str) -> Result<Vec<TablePreview>> {
        let path = Path::new(dump_path);

        // Handle gzip compression
        let actual_path = if dump_path.ends_with(".gz") {
            // Need to decompress first
            let file = File::open(path)
                .map_err(|e| CoreError::Internal(format!("Failed to open dump file: {}", e)))?;
            let mut reader = BufReader::new(file);
            let mut magic = [0u8; 2];
            if reader.read_exact(&mut magic).is_ok() && magic == GZIP_MAGIC {
                let decompressed_path = format!("{}.preview", dump_path);
                let file = File::open(path)
                    .map_err(|e| CoreError::Internal(format!("Failed to open dump file: {}", e)))?;
                let mut decoder = GzDecoder::new(file);
                let mut output_file = File::create(&decompressed_path).map_err(|e| {
                    CoreError::Internal(format!("Failed to create temp file: {}", e))
                })?;
                std::io::copy(&mut decoder, &mut output_file)
                    .map_err(|e| CoreError::Internal(format!("Failed to decompress: {}", e)))?;
                decompressed_path
            } else {
                dump_path.to_string()
            }
        } else {
            dump_path.to_string()
        };

        // Check if custom format
        let is_custom = self.detect_pg_dump_format(&actual_path)?;

        if is_custom {
            self.extract_tables_from_custom_format(&actual_path)
        } else {
            self.extract_tables_from_sql(&actual_path)
        }
    }

    /// Extract tables from pg_dump custom format using pg_restore -l
    fn extract_tables_from_custom_format(&self, dump_path: &str) -> Result<Vec<TablePreview>> {
        let mut cmd = Command::new("pg_restore");
        cmd.args(["-l", dump_path]);

        let output = cmd
            .output()
            .map_err(|e| CoreError::Internal(format!("Failed to execute pg_restore -l: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(CoreError::Internal(format!(
                "pg_restore -l failed: {}",
                stderr
            )));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut tables = Vec::new();
        let mut seen = std::collections::HashSet::new();

        // Parse pg_restore -l output
        // Format: "idx; seq schema table_name owner type description"
        // Example: "3432; 0 0 TABLE public users admin"
        for line in stdout.lines() {
            let line = line.trim();
            if line.starts_with(';') || line.is_empty() {
                continue;
            }

            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 6 && parts[3] == "TABLE" {
                let schema = parts[4].to_string();
                let table = parts[5].to_string();
                let key = format!("{}.{}", schema, table);
                if !seen.contains(&key) {
                    seen.insert(key);
                    tables.push(TablePreview {
                        schema_name: schema,
                        table_name: table,
                        estimated_size_bytes: None,
                        row_count_hint: None,
                        dependent_tables: Vec::new(),
                    });
                }
            }
        }

        Ok(tables)
    }

    /// Extract tables from plain SQL dump by parsing CREATE TABLE statements
    fn extract_tables_from_sql(&self, dump_path: &str) -> Result<Vec<TablePreview>> {
        use regex::Regex;
        use std::io::BufRead;

        let file = File::open(dump_path)
            .map_err(|e| CoreError::Internal(format!("Failed to open dump file: {}", e)))?;
        let reader = BufReader::new(file);

        let mut tables = Vec::new();
        let mut seen = std::collections::HashSet::new();

        // Track FK relationships: target_table -> [source_tables]
        // When target_table data is excluded, source_tables will have FK violations
        let mut fk_dependencies: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();

        // Match CREATE TABLE statements
        // Patterns:
        //   CREATE TABLE schema.table_name
        //   CREATE TABLE "schema"."table_name"
        //   CREATE TABLE table_name (schema will be public)
        let create_table_re = Regex::new(
            r#"(?i)CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\("#
        ).map_err(|e| CoreError::Internal(format!("Regex error: {}", e)))?;

        // Also match COPY statements to detect tables with data
        let copy_re = Regex::new(
            r#"(?i)COPY\s+(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*(?:\(|FROM)"#
        ).map_err(|e| CoreError::Internal(format!("Regex error: {}", e)))?;

        // Match ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES target_table
        // Pattern: ALTER TABLE source_table ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES target_table
        let fk_alter_re = Regex::new(
            r#"(?i)ALTER\s+TABLE\s+(?:ONLY\s+)?(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+ADD\s+CONSTRAINT\s+[^\s]+\s+FOREIGN\s+KEY\s*\([^)]+\)\s*REFERENCES\s+(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?"#
        ).map_err(|e| CoreError::Internal(format!("Regex error: {}", e)))?;

        // Match inline REFERENCES in CREATE TABLE
        // Pattern: column_name TYPE REFERENCES target_table(column)
        let fk_inline_re = Regex::new(
            r#"(?i)\s+REFERENCES\s+(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\("#
        ).map_err(|e| CoreError::Internal(format!("Regex error: {}", e)))?;

        // Match INSERT INTO statements
        // Pattern: INSERT INTO schema.table_name ... VALUES
        let insert_re = Regex::new(
            r#"(?i)INSERT\s+INTO\s+(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\("#
        ).map_err(|e| CoreError::Internal(format!("Regex error: {}", e)))?;

        // Track tables with data (from COPY and INSERT statements) to estimate size
        let mut tables_with_data: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        let mut current_copy_table: Option<String> = None;
        let mut copy_line_count = 0;

        // Track current INSERT INTO for multi-line INSERT statements
        let mut current_insert_table: Option<String> = None;

        // Track current CREATE TABLE context
        let mut current_create_table: Option<(String, String)> = None; // (schema, table)

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };

            // Check for end of COPY data
            if current_copy_table.is_some() && line == "\\." {
                if let Some(ref table_key) = current_copy_table {
                    tables_with_data.insert(table_key.clone(), copy_line_count);
                }
                current_copy_table = None;
                copy_line_count = 0;
                continue;
            }

            // Count lines in COPY data
            if current_copy_table.is_some() {
                copy_line_count += 1;
                continue;
            }

            // Match CREATE TABLE
            if let Some(caps) = create_table_re.captures(&line) {
                let schema = caps
                    .get(1)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_else(|| "public".to_string());
                let table = caps
                    .get(2)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();

                if !table.is_empty() {
                    let key = format!("{}.{}", schema, table);
                    if !seen.contains(&key) {
                        seen.insert(key);
                        tables.push(TablePreview {
                            schema_name: schema.clone(),
                            table_name: table.clone(),
                            estimated_size_bytes: None,
                            row_count_hint: None,
                            dependent_tables: Vec::new(),
                        });
                    }
                    // Track current CREATE TABLE for inline REFERENCES
                    current_create_table = Some((schema, table));
                }
            }

            // Detect end of CREATE TABLE (closing parenthesis with semicolon)
            if current_create_table.is_some() && line.contains(");") {
                current_create_table = None;
            }

            // Match COPY statement start
            if let Some(caps) = copy_re.captures(&line) {
                let schema = caps
                    .get(1)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_else(|| "public".to_string());
                let table = caps
                    .get(2)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();

                if !table.is_empty() && line.contains("FROM stdin") {
                    current_copy_table = Some(format!("{}.{}", schema, table));
                    copy_line_count = 0;
                }
            }

            // Match INSERT INTO statements to count rows
            // INSERT INTO table (...) VALUES (...), (...), ...;
            // Handle multi-line INSERT statements
            if let Some(caps) = insert_re.captures(&line) {
                let schema = caps
                    .get(1)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_else(|| "public".to_string());
                let table = caps
                    .get(2)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();

                if !table.is_empty() {
                    let table_key = format!("{}.{}", schema, table);
                    // Check if VALUES is on this line
                    if let Some(values_pos) = line.to_uppercase().find("VALUES") {
                        let values_part = &line[values_pos..];
                        // Count opening parentheses after VALUES (each represents a row)
                        let row_count = values_part.matches('(').count();
                        *tables_with_data.entry(table_key.clone()).or_insert(0) += row_count;
                    }
                    // If line ends without semicolon, more data follows
                    if !line.trim_end().ends_with(';') {
                        current_insert_table = Some(table_key);
                    }
                }
            }

            // Continue counting rows for multi-line INSERT statements
            if let Some(ref table_key) = current_insert_table {
                // Skip if this line matches INSERT (already processed above)
                if !line.to_uppercase().contains("INSERT INTO") {
                    // Count opening parentheses that start a value tuple
                    // Look for patterns like "(...)" which represent rows
                    let row_count = line.matches("('").count()
                        + line.matches("(NULL").count()
                        + line.matches("(DEFAULT").count();
                    // If no specific pattern found, count '(' at start of potential tuples
                    let row_count = if row_count == 0 {
                        // Count lines that look like value tuples (start with '(' after optional whitespace)
                        if line.trim_start().starts_with('(') {
                            1
                        } else {
                            0
                        }
                    } else {
                        row_count
                    };
                    *tables_with_data.entry(table_key.clone()).or_insert(0) += row_count;
                }
                // Check if INSERT statement ends
                if line.trim_end().ends_with(';') {
                    current_insert_table = None;
                }
            }

            // Match inline REFERENCES within CREATE TABLE
            if let Some((ref source_schema, ref source_table)) = current_create_table {
                if let Some(caps) = fk_inline_re.captures(&line) {
                    let target_schema = caps
                        .get(1)
                        .map(|m| m.as_str().to_string())
                        .unwrap_or_else(|| "public".to_string());
                    let target_table = caps
                        .get(2)
                        .map(|m| m.as_str().to_string())
                        .unwrap_or_default();

                    if !target_table.is_empty() {
                        let target_key = format!("{}.{}", target_schema, target_table);
                        let source_key = format!("{}.{}", source_schema, source_table);
                        // Don't add self-references
                        if target_key != source_key {
                            fk_dependencies
                                .entry(target_key)
                                .or_default()
                                .push(source_key);
                        }
                    }
                }
            }

            // Match ALTER TABLE FK constraint: source_table REFERENCES target_table
            // We want to track: when target_table is excluded, source_table data will fail
            if let Some(caps) = fk_alter_re.captures(&line) {
                let source_schema = caps
                    .get(1)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_else(|| "public".to_string());
                let source_table = caps
                    .get(2)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();
                let target_schema = caps
                    .get(3)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_else(|| "public".to_string());
                let target_table = caps
                    .get(4)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();

                if !source_table.is_empty() && !target_table.is_empty() {
                    let target_key = format!("{}.{}", target_schema, target_table);
                    let source_key = format!("{}.{}", source_schema, source_table);
                    fk_dependencies
                        .entry(target_key)
                        .or_default()
                        .push(source_key);
                }
            }
        }

        // Update row count hints from COPY data analysis
        for table in &mut tables {
            let key = format!("{}.{}", table.schema_name, table.table_name);
            if let Some(&count) = tables_with_data.get(&key) {
                table.row_count_hint = Some(count as i64);
            }
            // Add dependent tables (tables that reference this table via FK)
            // Deduplicate the list
            if let Some(deps) = fk_dependencies.get(&key) {
                let mut unique_deps: Vec<String> = deps.clone();
                unique_deps.sort();
                unique_deps.dedup();
                table.dependent_tables = unique_deps;
            }
        }

        Ok(tables)
    }

    /// Filter plain SQL dump to exclude data (COPY and INSERT statements) for specified tables
    /// Keeps schema definitions (CREATE TABLE, ALTER TABLE, CREATE INDEX, etc.)
    /// Returns path to the filtered dump file
    fn filter_sql_dump_data_only(
        &self,
        dump_path: &str,
        excluded_tables: &[String],
    ) -> Result<String> {
        use regex::Regex;
        use std::io::{BufRead, Write};

        let filtered_path = format!("{}.filtered", dump_path);

        let file = File::open(dump_path)
            .map_err(|e| CoreError::Internal(format!("Failed to open dump file: {}", e)))?;
        let reader = BufReader::new(file);

        let mut output = File::create(&filtered_path)
            .map_err(|e| CoreError::Internal(format!("Failed to create filtered dump: {}", e)))?;

        // Match: COPY schema.table or COPY table
        let copy_re = Regex::new(
            r#"(?i)^COPY\s+(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\("#,
        )
        .map_err(|e| CoreError::Internal(format!("Regex error: {}", e)))?;

        // Match: INSERT INTO schema.table or INSERT INTO table
        let insert_re = Regex::new(
            r#"(?i)^INSERT\s+INTO\s+(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*[\(\s]"#
        ).map_err(|e| CoreError::Internal(format!("Regex error: {}", e)))?;

        // Convert excluded_tables to a HashSet of (schema, table) for quick lookup
        let excluded_set: std::collections::HashSet<(String, String)> = excluded_tables
            .iter()
            .map(|t| {
                let parts: Vec<&str> = t.split('.').collect();
                if parts.len() == 2 {
                    (parts[0].to_string(), parts[1].to_string())
                } else {
                    ("public".to_string(), parts[0].to_string())
                }
            })
            .collect();

        // Helper to check if a table is excluded
        let is_excluded = |schema: &str, table: &str| -> bool {
            excluded_set.contains(&(schema.to_string(), table.to_string()))
        };

        let mut skip_copy_data = false;
        let mut skip_insert_statement = false;
        let mut skipped_tables: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };

            // Handle COPY data skip - skip until we hit the end marker
            if skip_copy_data {
                if line == "\\." {
                    skip_copy_data = false;
                }
                continue;
            }

            // Handle multi-line INSERT statement skip
            if skip_insert_statement {
                // INSERT statements end with a semicolon
                if line.trim_end().ends_with(';') {
                    skip_insert_statement = false;
                }
                continue;
            }

            // Check if this is a COPY statement for an excluded table
            if let Some(caps) = copy_re.captures(&line) {
                let schema = caps.get(1).map(|m| m.as_str()).unwrap_or("public");
                let table = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                if is_excluded(schema, table) {
                    // Skip this COPY statement and its data
                    if line.contains("FROM stdin") {
                        skip_copy_data = true;
                        skipped_tables.insert(format!("{}.{}", schema, table));
                    }
                    continue;
                }
            }

            // Check if this is an INSERT statement for an excluded table
            if let Some(caps) = insert_re.captures(&line) {
                let schema = caps.get(1).map(|m| m.as_str()).unwrap_or("public");
                let table = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                if is_excluded(schema, table) {
                    skipped_tables.insert(format!("{}.{}", schema, table));
                    // Check if INSERT spans multiple lines
                    if !line.trim_end().ends_with(';') {
                        skip_insert_statement = true;
                    }
                    continue;
                }
            }

            // Write all other lines (including CREATE TABLE, ALTER TABLE, CREATE INDEX, etc.)
            writeln!(output, "{}", line).map_err(|e| {
                CoreError::Internal(format!("Failed to write filtered dump: {}", e))
            })?;
        }

        let skipped_list: Vec<String> = skipped_tables.into_iter().collect();
        info!(
            "Created filtered dump excluding data for {} tables: {:?}",
            skipped_list.len(),
            skipped_list
        );

        Ok(filtered_path)
    }
}

/// Table preview info extracted from dump file
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TablePreview {
    pub schema_name: String,
    pub table_name: String,
    pub estimated_size_bytes: Option<i64>,
    pub row_count_hint: Option<i64>,
    /// Tables that have foreign key references TO this table
    /// If this table's data is excluded, these tables will have FK violations
    #[serde(default)]
    pub dependent_tables: Vec<String>,
}

#[async_trait]
impl DbAdapter for PostgresAdapter {
    async fn restore_dump(&self, dump_path: &str, db_name: &str) -> Result<Vec<String>> {
        info!("Restoring dump {} to database {}", dump_path, db_name);

        // Detect dump format from magic bytes, not extension
        let actual_path = self.decompress_if_needed(dump_path).await?;
        let is_custom_format = self.detect_pg_dump_format(&actual_path)?;

        // Check if this is a pg_dumpall format (cluster dump)
        let pg_dumpall_databases = if !is_custom_format {
            self.detect_pg_dumpall_databases(&actual_path)?
        } else {
            Vec::new()
        };

        // For pg_dumpall, rewrite the dump with prefixed database names
        // This allows multiple dumps to coexist without overwriting each other
        let (restore_path, restored_databases) = if !pg_dumpall_databases.is_empty() {
            info!(
                "pg_dumpall format detected, databases in dump: {:?}",
                pg_dumpall_databases
            );
            // Use db_name as prefix (e.g., "sandbox_abc123")
            let (rewritten_path, prefixed_dbs) =
                self.rewrite_pg_dumpall_with_prefix(&actual_path, db_name)?;
            (rewritten_path, prefixed_dbs)
        } else {
            (actual_path.clone(), vec![db_name.to_string()])
        };

        // Create database first (only for non-pg_dumpall dumps)
        if pg_dumpall_databases.is_empty() {
            self.create_database(db_name).await?;
        }

        info!(
            "Detected dump format: {}",
            if is_custom_format {
                "custom/tar"
            } else if !pg_dumpall_databases.is_empty() {
                "pg_dumpall (cluster)"
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
                "--no-tablespaces", // Ignore tablespace settings from source DB
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
                // Only fail on fatal errors, not on ignorable warnings like
                // tablespace, transaction_timeout, or permission issues
                let is_fatal = stderr.contains("FATAL")
                    || (stderr.contains("ERROR")
                        && !stderr.contains("tablespace")
                        && !stderr.contains("transaction_timeout")
                        && !stderr.contains("errors ignored on restore"));
                if is_fatal {
                    return Err(CoreError::RestoreFailed(stderr.to_string()));
                }
                warn!("pg_restore completed with warnings: {}", stderr);
            }
        } else {
            // Plain SQL format - use psql command for proper handling of COPY statements
            info!("Executing SQL file with psql: {}", restore_path);

            // For pg_dumpall format, connect to postgres database (default)
            // The dump itself will create and connect to the target databases
            let connect_db = if !pg_dumpall_databases.is_empty() {
                "postgres"
            } else {
                db_name
            };

            let mut cmd = Command::new("psql");
            cmd.args([
                "-h",
                &self.host,
                "-p",
                &self.port.to_string(),
                "-U",
                &self.user,
                "-d",
                connect_db,
                "-v",
                "ON_ERROR_STOP=0", // Continue on errors
                "-f",
                &restore_path, // Use the (possibly rewritten) dump path
            ]);

            if let Some(ref password) = self.password {
                cmd.env("PGPASSWORD", password);
            }

            let output = cmd.output();

            match output {
                Ok(output) => {
                    if !output.status.success() {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        // Only fail on fatal errors, not warnings or role errors
                        if stderr.contains("FATAL") {
                            return Err(CoreError::RestoreFailed(stderr.to_string()));
                        }
                        warn!("psql completed with warnings: {}", stderr);
                    }
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    info!(
                        "psql output: {}",
                        stdout.chars().take(500).collect::<String>()
                    );
                }
                Err(e) => {
                    // psql not available, fall back to SQLx line-by-line execution
                    warn!("psql not available ({}), falling back to SQLx execution", e);
                    self.execute_sql_with_sqlx(&actual_path, db_name).await?;
                }
            }
        }

        info!(
            "Successfully restored dump, available databases: {:?}",
            restored_databases
        );
        Ok(restored_databases)
    }

    async fn restore_dump_with_exclusions(
        &self,
        dump_path: &str,
        db_name: &str,
        excluded_tables: &[String],
    ) -> Result<Vec<String>> {
        if excluded_tables.is_empty() {
            // No exclusions, use regular restore
            return self.restore_dump(dump_path, db_name).await;
        }

        info!(
            "Restoring dump {} to database {} with {} excluded tables",
            dump_path,
            db_name,
            excluded_tables.len()
        );

        // Detect dump format from magic bytes, not extension
        let actual_path = self.decompress_if_needed(dump_path).await?;
        let is_custom_format = self.detect_pg_dump_format(&actual_path)?;

        // Create database first
        self.create_database(db_name).await?;

        if is_custom_format {
            // Custom format - use pg_restore with TOC filtering
            // pg_restore doesn't have --exclude-table-data, so we use the -l/-L approach:
            // 1. List TOC entries with pg_restore -l
            // 2. Filter out DATA entries for excluded tables
            // 3. Restore with filtered TOC using pg_restore -L

            // Step 1: Get TOC listing
            let mut list_cmd = Command::new("pg_restore");
            list_cmd.arg("-l").arg(&actual_path);

            if let Some(ref password) = self.password {
                list_cmd.env("PGPASSWORD", password);
            }

            let list_output = list_cmd.output().map_err(|e| {
                CoreError::RestoreFailed(format!("Failed to execute pg_restore -l: {}", e))
            })?;

            if !list_output.status.success() {
                let stderr = String::from_utf8_lossy(&list_output.stderr);
                return Err(CoreError::RestoreFailed(format!(
                    "pg_restore -l failed: {}",
                    stderr
                )));
            }

            let toc_content = String::from_utf8_lossy(&list_output.stdout);

            // Step 2: Filter TOC - remove DATA entries for excluded tables
            // TOC lines look like:
            //   3456; 0 16401 TABLE DATA public users postgres
            let excluded_set: std::collections::HashSet<(String, String)> = excluded_tables
                .iter()
                .map(|t| {
                    let parts: Vec<&str> = t.split('.').collect();
                    if parts.len() == 2 {
                        (parts[0].to_string(), parts[1].to_string())
                    } else {
                        ("public".to_string(), parts[0].to_string())
                    }
                })
                .collect();

            let mut filtered_toc = String::new();
            let mut excluded_count = 0;
            for line in toc_content.lines() {
                let trimmed = line.trim();
                // Comment lines or empty lines pass through
                if trimmed.starts_with(';') || trimmed.is_empty() {
                    filtered_toc.push_str(line);
                    filtered_toc.push('\n');
                    continue;
                }

                // Check if this is a TABLE DATA entry for an excluded table
                // Format: "id; seq offset oid TYPE schema table owner"
                // Example: "3456; 0 16401 TABLE DATA public users postgres"
                let should_exclude = if trimmed.contains("TABLE DATA") {
                    // Parse: split by whitespace, find schema and table after "TABLE DATA"
                    let parts: Vec<&str> = trimmed.split_whitespace().collect();
                    if let Some(td_pos) = parts
                        .windows(2)
                        .position(|w| w[0] == "TABLE" && w[1] == "DATA")
                    {
                        // schema is at td_pos+2, table at td_pos+3
                        if parts.len() > td_pos + 3 {
                            let schema = parts[td_pos + 2];
                            let table = parts[td_pos + 3];
                            excluded_set.contains(&(schema.to_string(), table.to_string()))
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                };

                if should_exclude {
                    // Comment out the line instead of removing it
                    filtered_toc.push_str("; EXCLUDED: ");
                    filtered_toc.push_str(line);
                    filtered_toc.push('\n');
                    excluded_count += 1;
                } else {
                    filtered_toc.push_str(line);
                    filtered_toc.push('\n');
                }
            }

            info!(
                "Filtered TOC: excluded {} TABLE DATA entries for tables: {:?}",
                excluded_count, excluded_tables
            );

            // Step 3: Write filtered TOC to a temp file
            let toc_path = format!("{}.filtered_toc", actual_path);
            std::fs::write(&toc_path, &filtered_toc).map_err(|e| {
                CoreError::RestoreFailed(format!("Failed to write filtered TOC: {}", e))
            })?;

            // Step 4: Restore using filtered TOC
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
                "--no-tablespaces",
                "-L",
                &toc_path,
            ]);

            cmd.arg(&actual_path);

            if let Some(ref password) = self.password {
                cmd.env("PGPASSWORD", password);
            }

            let output = cmd.output().map_err(|e| {
                CoreError::RestoreFailed(format!("Failed to execute pg_restore: {}", e))
            })?;

            // Clean up temp TOC file
            let _ = std::fs::remove_file(&toc_path);

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let is_fatal = stderr.contains("FATAL")
                    || stderr.contains("unrecognized")
                    || (stderr.contains("ERROR")
                        && !stderr.contains("tablespace")
                        && !stderr.contains("transaction_timeout")
                        && !stderr.contains("errors ignored on restore"));
                if is_fatal {
                    return Err(CoreError::RestoreFailed(stderr.to_string()));
                }
                warn!("pg_restore completed with warnings: {}", stderr);
            }
        } else {
            // Plain SQL format - filter out data only (keep schema)
            info!(
                "Filtering plain SQL dump, excluding data for tables: {:?}",
                excluded_tables
            );
            let filtered_path = self.filter_sql_dump_data_only(&actual_path, excluded_tables)?;

            // Execute the filtered dump
            let mut cmd = Command::new("psql");
            cmd.args([
                "-h",
                &self.host,
                "-p",
                &self.port.to_string(),
                "-U",
                &self.user,
                "-d",
                db_name,
                "-v",
                "ON_ERROR_STOP=0",
                "-f",
                &filtered_path,
            ]);

            if let Some(ref password) = self.password {
                cmd.env("PGPASSWORD", password);
            }

            let output = cmd.output();

            match output {
                Ok(output) => {
                    if !output.status.success() {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        if stderr.contains("FATAL") {
                            return Err(CoreError::RestoreFailed(stderr.to_string()));
                        }
                        warn!("psql completed with warnings: {}", stderr);
                    }
                }
                Err(e) => {
                    warn!("psql not available ({}), falling back to SQLx execution", e);
                    self.execute_sql_with_sqlx(&filtered_path, db_name).await?;
                }
            }

            // Clean up filtered file
            let _ = std::fs::remove_file(&filtered_path);
        }

        info!(
            "Successfully restored dump with exclusions, database: {}",
            db_name
        );
        Ok(vec![db_name.to_string()])
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
            SELECT DISTINCT
                tc.constraint_name,
                tc.table_schema as source_schema,
                tc.table_name as source_table,
                kcu.column_name as source_column,
                ccu.table_schema as target_schema,
                ccu.table_name as target_table,
                ccu.column_name as target_column,
                rc.delete_rule,
                rc.update_rule,
                kcu.ordinal_position
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
                AND tc.constraint_schema = kcu.constraint_schema
            JOIN information_schema.constraint_column_usage ccu
                ON ccu.constraint_name = tc.constraint_name
                AND ccu.constraint_schema = tc.constraint_schema
            JOIN information_schema.referential_constraints rc
                ON tc.constraint_name = rc.constraint_name
                AND tc.constraint_schema = rc.constraint_schema
            WHERE tc.constraint_type = 'FOREIGN KEY'
                AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
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

    async fn analyze_database(&self, db_name: &str) -> Result<()> {
        info!("Running ANALYZE on database {}", db_name);

        let db_url = self.build_db_url(db_name);
        let db_pool = PgPool::connect(&db_url).await?;

        // Run ANALYZE on all tables to update statistics
        sqlx::query("ANALYZE").execute(&db_pool).await?;

        info!("ANALYZE completed for database {}", db_name);
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

    /// Fallback SQL execution when psql is not available
    /// This handles simple SQL but may not work with COPY commands
    async fn execute_sql_with_sqlx(&self, sql_path: &str, db_name: &str) -> Result<()> {
        info!("Executing SQL file directly with SQLx (fallback mode)");

        let sql_content = tokio::fs::read_to_string(sql_path)
            .await
            .map_err(|e| CoreError::RestoreFailed(format!("Failed to read SQL file: {}", e)))?;

        let db_url = self.build_db_url(db_name);
        let db_pool = PgPool::connect(&db_url).await.map_err(|e| {
            CoreError::RestoreFailed(format!("Failed to connect to database: {}", e))
        })?;

        let mut executed = 0;
        let mut skipped = 0;
        let mut errors = 0;
        let mut in_copy_block = false;

        // Parse SQL more carefully, handling COPY blocks
        let mut current_statement = String::new();

        for line in sql_content.lines() {
            let trimmed = line.trim();

            // Handle COPY block end
            if in_copy_block {
                if trimmed == "\\." {
                    in_copy_block = false;
                    // Skip COPY data - we can't handle it with SQLx
                    current_statement.clear();
                    skipped += 1;
                }
                continue;
            }

            // Skip comments and psql meta-commands
            if trimmed.starts_with("--") || trimmed.starts_with("\\") {
                continue;
            }

            // Skip empty lines
            if trimmed.is_empty() {
                continue;
            }

            // Check for COPY command start
            if trimmed.to_uppercase().starts_with("COPY ") && trimmed.contains("FROM stdin") {
                in_copy_block = true;
                skipped += 1;
                continue;
            }

            // Accumulate statement
            current_statement.push_str(line);
            current_statement.push('\n');

            // Check if statement is complete (ends with semicolon)
            if trimmed.ends_with(';') {
                let stmt = current_statement.trim();

                // Skip certain statements
                let upper = stmt.to_uppercase();
                if upper.starts_with("ALTER ROLE")
                    || upper.starts_with("CREATE ROLE")
                    || upper.starts_with("DROP ROLE")
                    || upper.starts_with("GRANT")
                    || upper.starts_with("REVOKE")
                    || upper.starts_with("ALTER DATABASE")
                    || upper.contains("OWNER TO")
                    || upper.contains("SET SESSION AUTHORIZATION")
                    || upper.contains("SELECT PG_CATALOG.SET_CONFIG")
                {
                    skipped += 1;
                    current_statement.clear();
                    continue;
                }

                // Execute statement
                match sqlx::query(stmt).execute(&db_pool).await {
                    Ok(_) => executed += 1,
                    Err(e) => {
                        let error_msg = e.to_string();
                        if error_msg.contains("already exists")
                            || error_msg.contains("does not exist")
                            || error_msg.contains("role")
                        {
                            errors += 1;
                        } else {
                            warn!(
                                "SQL error (continuing): {} - {}",
                                error_msg,
                                stmt.chars().take(100).collect::<String>()
                            );
                            errors += 1;
                        }
                    }
                }

                current_statement.clear();
            }
        }

        info!(
            "SQLx execution completed: {} executed, {} skipped, {} errors",
            executed, skipped, errors
        );

        db_pool.close().await;
        Ok(())
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
