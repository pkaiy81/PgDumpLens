//! Application configuration

use anyhow::{Context, Result};

/// Application configuration
#[derive(Debug, Clone)]
pub struct AppConfig {
    /// Server host
    pub host: String,
    /// Server port
    pub port: u16,
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
    /// Default TTL in days
    pub ttl_days: u32,
}

impl AppConfig {
    /// Load configuration from environment variables
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            host: std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "8080".to_string())
                .parse()
                .context("Invalid PORT")?,
            database_url: std::env::var("DATABASE_URL").context("DATABASE_URL is required")?,
            sandbox_host: std::env::var("SANDBOX_HOST").unwrap_or_else(|_| "localhost".to_string()),
            sandbox_port: std::env::var("SANDBOX_PORT")
                .unwrap_or_else(|_| "5432".to_string())
                .parse()
                .context("Invalid SANDBOX_PORT")?,
            sandbox_user: std::env::var("SANDBOX_USER").unwrap_or_else(|_| "postgres".to_string()),
            sandbox_password: std::env::var("SANDBOX_PASSWORD").ok(),
            upload_dir: std::env::var("UPLOAD_DIR").unwrap_or_else(|_| "/data/uploads".to_string()),
            ttl_days: std::env::var("TTL_DAYS")
                .unwrap_or_else(|_| "7".to_string())
                .parse()
                .context("Invalid TTL_DAYS")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_defaults() {
        std::env::set_var("DATABASE_URL", "postgres://localhost/test");
        let config = AppConfig::from_env().unwrap();

        assert_eq!(config.host, "0.0.0.0");
        assert_eq!(config.port, 8080);
        assert_eq!(config.ttl_days, 7);

        std::env::remove_var("DATABASE_URL");
    }
}
