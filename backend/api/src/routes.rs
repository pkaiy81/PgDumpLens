//! API route definitions

use axum::{
    extract::DefaultBodyLimit,
    routing::{delete, get, post, put},
    Router,
};
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::handlers;
use crate::state::AppState;

/// Maximum upload size: 5GB
const MAX_UPLOAD_SIZE: usize = 5 * 1024 * 1024 * 1024;

/// Create the main application router
pub fn create_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        // Health check
        .route("/health", get(handlers::health_check))
        // Dump management
        .route("/api/dumps", post(handlers::dumps::create_dump))
        .route("/api/dumps", get(handlers::dumps::list_dumps))
        .route("/api/dumps/:id", get(handlers::dumps::get_dump))
        .route("/api/dumps/:id", delete(handlers::dumps::delete_dump))
        .route(
            "/api/dumps/:id/upload",
            put(handlers::dumps::upload_dump).layer(DefaultBodyLimit::max(MAX_UPLOAD_SIZE)),
        )
        .route(
            "/api/dumps/:id/restore",
            post(handlers::dumps::restore_dump),
        )
        .route(
            "/api/dumps/:id/databases",
            get(handlers::dumps::get_dump_databases),
        )
        // Schema & Data
        .route("/api/dumps/:id/schema", get(handlers::schema::get_schema))
        .route(
            "/api/dumps/:id/tables/:table",
            get(handlers::schema::get_table_data),
        )
        .route(
            "/api/dumps/:id/suggest",
            get(handlers::schema::suggest_values),
        )
        // Diff comparison
        .route(
            "/api/dumps/:base_id/compare/:compare_id",
            get(handlers::diff::compare_dumps),
        )
        // Search
        .route(
            "/api/dumps/:id/search",
            get(handlers::search::search_in_dump),
        )
        // Relationships & Risk
        .route(
            "/api/dumps/:id/relation/explain",
            post(handlers::relation::explain_relation),
        )
        .route(
            "/api/dumps/:id/risk/table/:schema/:table",
            get(handlers::risk::get_table_risk),
        )
        .route(
            "/api/dumps/:id/risk/column/:schema/:table/:column",
            get(handlers::risk::get_column_risk),
        )
        // View by slug
        .route(
            "/api/dumps/by-slug/:slug",
            get(handlers::dumps::get_dump_by_slug),
        )
        // Layers
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}
