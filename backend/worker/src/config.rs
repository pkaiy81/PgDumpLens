//! Worker configuration

use anyhow::{Context, Result};

/// Worker configuration
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    /// Metadata database URL
    pub database_url: String,
    /// Sandbox PostgreSQL host
    pub sandbox_host: String,
    /// Sandbox PostgreSQL port
    pub sandbox_port: u16,
    /// Sandbox PostgreSQL user
    pub sandbox_user: String,
    /// Sandbox PostgreSQL password
    pub sandbox_password: Option<String>,
    /// Upload directory path
    pub upload_dir: String,
    /// Poll interval in seconds
    pub poll_interval_secs: u64,
    /// Cleanup interval in seconds (how often to check for expired dumps)
    pub cleanup_interval_secs: u64,
}

impl WorkerConfig {
    /// Load configuration from environment variables
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            database_url: std::env::var("DATABASE_URL").context("DATABASE_URL is required")?,
            sandbox_host: std::env::var("SANDBOX_HOST").unwrap_or_else(|_| "localhost".to_string()),
            sandbox_port: std::env::var("SANDBOX_PORT")
                .unwrap_or_else(|_| "5432".to_string())
                .parse()
                .context("Invalid SANDBOX_PORT")?,
            sandbox_user: std::env::var("SANDBOX_USER").unwrap_or_else(|_| "postgres".to_string()),
            sandbox_password: std::env::var("SANDBOX_PASSWORD").ok(),
            upload_dir: std::env::var("UPLOAD_DIR").unwrap_or_else(|_| "/data/uploads".to_string()),
            poll_interval_secs: std::env::var("POLL_INTERVAL_SECS")
                .unwrap_or_else(|_| "5".to_string())
                .parse()
                .context("Invalid POLL_INTERVAL_SECS")?,
            cleanup_interval_secs: std::env::var("CLEANUP_INTERVAL_SECS")
                .unwrap_or_else(|_| "3600".to_string()) // Default: 1 hour
                .parse()
                .context("Invalid CLEANUP_INTERVAL_SECS")?,
        })
    }

    /// Build sandbox connection URL
    pub fn sandbox_url(&self) -> String {
        if let Some(ref password) = self.sandbox_password {
            format!(
                "postgres://{}:{}@{}:{}/postgres",
                self.sandbox_user, password, self.sandbox_host, self.sandbox_port
            )
        } else {
            format!(
                "postgres://{}@{}:{}/postgres",
                self.sandbox_user, self.sandbox_host, self.sandbox_port
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sandbox_url_without_password() {
        let config = WorkerConfig {
            database_url: "test".to_string(),
            sandbox_host: "localhost".to_string(),
            sandbox_port: 5432,
            sandbox_user: "postgres".to_string(),
            sandbox_password: None,
            upload_dir: "/data".to_string(),
            poll_interval_secs: 5,
        };

        assert_eq!(
            config.sandbox_url(),
            "postgres://postgres@localhost:5432/postgres"
        );
    }

    #[test]
    fn test_sandbox_url_with_password() {
        let config = WorkerConfig {
            database_url: "test".to_string(),
            sandbox_host: "localhost".to_string(),
            sandbox_port: 5432,
            sandbox_user: "postgres".to_string(),
            sandbox_password: Some("secret".to_string()),
            upload_dir: "/data".to_string(),
            poll_interval_secs: 5,
        };

        assert_eq!(
            config.sandbox_url(),
            "postgres://postgres:secret@localhost:5432/postgres"
        );
    }
}
