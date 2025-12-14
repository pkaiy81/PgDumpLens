//! Application state

use anyhow::Result;
use sqlx::postgres::PgPool;
use std::sync::Arc;

use crate::config::AppConfig;

/// Shared application state
#[derive(Clone)]
pub struct AppState {
    /// Metadata database pool
    pub db_pool: PgPool,
    /// Configuration
    pub config: Arc<AppConfig>,
}

impl AppState {
    /// Create new application state
    pub async fn new(config: &AppConfig) -> Result<Self> {
        let db_pool = PgPool::connect(&config.database_url).await?;

        Ok(Self {
            db_pool,
            config: Arc::new(config.clone()),
        })
    }
}
