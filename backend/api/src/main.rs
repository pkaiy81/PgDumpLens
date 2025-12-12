//! DB Viewer API Server

mod config;
mod error;
mod handlers;
mod routes;
mod state;

use std::net::SocketAddr;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info,db_viewer_api=debug".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Load configuration
    dotenvy::dotenv().ok();
    let config = config::AppConfig::from_env()?;

    info!("Starting DB Viewer API Server");
    info!("Listening on {}:{}", config.host, config.port);

    // Create application state
    let state = state::AppState::new(&config).await?;

    // Build router
    let app = routes::create_router(state);

    // Start server
    let addr: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    
    axum::serve(listener, app).await?;

    Ok(())
}
