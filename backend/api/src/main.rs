//! DB Viewer API Server

mod config;
mod error;
mod handlers;
mod routes;
mod state;

use std::net::SocketAddr;
use std::time::Duration;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, Layer};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing. Filters are per-layer so the console's notice
    // capture sees sqlx notice events regardless of RUST_LOG.
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer().with_filter(tracing_subscriber::EnvFilter::new(
                std::env::var("RUST_LOG").unwrap_or_else(|_| "info,db_viewer_api=debug".into()),
            )),
        )
        .with(
            handlers::console::notice::NoticeCaptureLayer
                .with_filter(handlers::console::notice::NoticeCaptureLayer::filter()),
        )
        .init();

    // Load configuration
    dotenvy::dotenv().ok();
    let config = config::AppConfig::from_env()?;

    info!("Starting DB Viewer API Server");
    info!("Listening on {}:{}", config.host, config.port);

    // Create application state
    let state = state::AppState::new(&config).await?;

    // Spawn the idle console-session sweeper.
    let sessions = state.console_sessions.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(
            handlers::console::session::SWEEP_INTERVAL_SECS,
        ));
        loop {
            tick.tick().await;
            for s in sessions.sweep_idle() {
                handlers::console::session::close_session(s).await;
            }
        }
    });

    // Build router
    let app = routes::create_router(state);

    // Start server
    let addr: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;

    axum::serve(listener, app).await?;

    Ok(())
}
