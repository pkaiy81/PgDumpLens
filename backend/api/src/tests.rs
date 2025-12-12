//! Integration tests for API handlers

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use tower::ServiceExt;
use serde_json::json;

// Note: These tests require a running PostgreSQL database
// Use testcontainers in integration test setup

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn test_request_serialization() {
        let json = r#"{"name": "test dump"}"#;
        let req: crate::handlers::dumps::CreateDumpRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.name, Some("test dump".to_string()));
    }

    #[test]
    fn test_response_serialization() {
        let response = crate::handlers::dumps::CreateDumpResponse {
            id: uuid::Uuid::nil(),
            slug: "test-slug".to_string(),
            upload_url: "/api/dumps/123/upload".to_string(),
        };
        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("test-slug"));
    }
}

#[cfg(test)]
mod health_tests {
    use super::*;

    #[tokio::test]
    async fn test_health_check_response() {
        let response = crate::handlers::health_check().await;
        assert_eq!(response.status, "ok");
        assert!(!response.version.is_empty());
    }
}
