//! DB Viewer Worker
//!
//! Async worker that processes dump restoration and schema analysis jobs.
//! Also handles TTL-based cleanup of expired dumps.

mod config;
mod jobs;

use sqlx::postgres::PgPool;
use std::time::{Duration, Instant};
use tracing::{error, info};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

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
    info!(
        "Job poll interval: {}s, Cleanup interval: {}s",
        config.poll_interval_secs, config.cleanup_interval_secs
    );

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

    // Track when cleanup was last run
    let mut last_cleanup = Instant::now();

    // Main worker loop
    loop {
        // Process pending jobs (restore, analyze)
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

        // Run cleanup if enough time has passed
        if last_cleanup.elapsed() >= Duration::from_secs(config.cleanup_interval_secs) {
            info!("Running TTL cleanup...");
            match jobs::cleanup_expired_dumps(&db_pool, &adapter, &config).await {
                Ok(cleaned) => {
                    if cleaned > 0 {
                        info!("Cleaned up {} expired dumps", cleaned);
                    } else {
                        info!("No expired dumps to cleanup");
                    }
                }
                Err(e) => {
                    error!("Error during cleanup: {}", e);
                }
            }
            last_cleanup = Instant::now();
        }

        // Sleep before next poll
        tokio::time::sleep(Duration::from_secs(config.poll_interval_secs)).await;
    }
}
