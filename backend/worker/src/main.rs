//! DB Viewer Worker
//!
//! Async worker that processes dump restoration and schema analysis jobs.

mod config;
mod jobs;

use std::time::Duration;
use tracing::{info, error};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use sqlx::postgres::PgPool;

use db_viewer_core::adapter::PostgresAdapter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info,db_viewer_worker=debug".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Load configuration
    dotenvy::dotenv().ok();
    let config = config::WorkerConfig::from_env()?;

    info!("Starting DB Viewer Worker");

    // Connect to metadata database
    let db_pool = PgPool::connect(&config.database_url).await?;
    
    // Connect to sandbox postgres (for management operations)
    let sandbox_pool = PgPool::connect(&config.sandbox_url()).await?;
    
    let adapter = PostgresAdapter::new(
        sandbox_pool,
        config.sandbox_host.clone(),
        config.sandbox_port,
        config.sandbox_user.clone(),
        config.sandbox_password.clone(),
    );

    // Main worker loop
    loop {
        match jobs::process_pending_jobs(&db_pool, &adapter, &config).await {
            Ok(processed) => {
                if processed > 0 {
                    info!("Processed {} jobs", processed);
                }
            }
            Err(e) => {
                error!("Error processing jobs: {}", e);
            }
        }

        // Sleep before next poll
        tokio::time::sleep(Duration::from_secs(config.poll_interval_secs)).await;
    }
}
