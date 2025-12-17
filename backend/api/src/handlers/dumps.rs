//! Dump management handlers

use axum::{
    extract::{Multipart, Path, State},
    Json,
};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use db_viewer_core::domain::{Dump, DumpStatus};

/// Create dump request
#[derive(Debug, Deserialize)]
pub struct CreateDumpRequest {
    pub name: Option<String>,
    pub slug: Option<String>,
}

/// Create dump response
#[derive(Debug, Serialize)]
pub struct CreateDumpResponse {
    pub id: Uuid,
    pub slug: String,
    pub upload_url: String,
}

/// Create a new dump session
pub async fn create_dump(
    State(state): State<AppState>,
    Json(req): Json<CreateDumpRequest>,
) -> ApiResult<Json<CreateDumpResponse>> {
    let id = Uuid::new_v4();
    let now = Utc::now();
    let expires_at = now + Duration::days(state.config.ttl_days as i64);

    // Generate slug
    let slug = match req.slug {
        Some(s) => slugify(&s),
        None => generate_short_id(),
    };

    // Check slug uniqueness
    let existing: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM dumps WHERE slug = $1 AND status != 'DELETED'")
            .bind(&slug)
            .fetch_optional(&state.db_pool)
            .await?;

    if existing.is_some() {
        return Err(ApiError::Conflict(format!(
            "Slug '{}' already exists",
            slug
        )));
    }

    // Insert dump record
    sqlx::query(
        r#"
        INSERT INTO dumps (id, slug, name, status, created_at, updated_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $5, $6)
        "#,
    )
    .bind(id)
    .bind(&slug)
    .bind(&req.name)
    .bind(DumpStatus::Created.as_str())
    .bind(now)
    .bind(expires_at)
    .execute(&state.db_pool)
    .await?;

    Ok(Json(CreateDumpResponse {
        id,
        slug: slug.clone(),
        upload_url: format!("/api/dumps/{}/upload", id),
    }))
}

/// List all dumps
pub async fn list_dumps(State(state): State<AppState>) -> ApiResult<Json<Vec<DumpSummary>>> {
    let rows = sqlx::query(
        r#"
        SELECT id, slug, name, status, file_size, created_at, expires_at
        FROM dumps
        WHERE status != 'DELETED'
        ORDER BY created_at DESC
        LIMIT 100
        "#,
    )
    .fetch_all(&state.db_pool)
    .await?;

    let dumps: Vec<DumpSummary> = rows
        .iter()
        .map(|row| DumpSummary {
            id: row.get("id"),
            slug: row.get("slug"),
            name: row.get("name"),
            status: row.get("status"),
            file_size: row.get("file_size"),
            created_at: row.get("created_at"),
            expires_at: row.get("expires_at"),
        })
        .collect();

    Ok(Json(dumps))
}

/// Dump summary for list
#[derive(Debug, Serialize)]
pub struct DumpSummary {
    pub id: Uuid,
    pub slug: String,
    pub name: Option<String>,
    pub status: String,
    pub file_size: Option<i64>,
    pub created_at: chrono::DateTime<Utc>,
    pub expires_at: chrono::DateTime<Utc>,
}

/// Get dump by ID
pub async fn get_dump(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Dump>> {
    let dump = fetch_dump_by_id(&state, id).await?;
    Ok(Json(dump))
}

/// Get dump by slug
pub async fn get_dump_by_slug(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> ApiResult<Json<Dump>> {
    let row = sqlx::query(
        r#"
        SELECT id, slug, original_filename, name, status, error_message,
               file_size, created_at, updated_at, expires_at, sandbox_db_name
        FROM dumps
        WHERE slug = $1 AND status != 'DELETED'
        "#,
    )
    .bind(&slug)
    .fetch_optional(&state.db_pool)
    .await?;

    match row {
        Some(row) => Ok(Json(row_to_dump(&row))),
        None => Err(ApiError::NotFound(format!(
            "Dump with slug '{}' not found",
            slug
        ))),
    }
}

/// Upload dump file
pub async fn upload_dump(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> ApiResult<Json<Dump>> {
    // Verify dump exists and is in correct state
    let dump = fetch_dump_by_id(&state, id).await?;
    if dump.status != DumpStatus::Created {
        return Err(ApiError::BadRequest(format!(
            "Dump is in '{}' state, expected 'CREATED'",
            dump.status.as_str()
        )));
    }

    // Create upload directory
    let upload_dir = format!("{}/{}", state.config.upload_dir, id);
    tokio::fs::create_dir_all(&upload_dir)
        .await
        .map_err(|e| ApiError::Internal(format!("Failed to create upload directory: {}", e)))?;

    let mut file_size: i64 = 0;
    let mut original_filename: Option<String> = None;

    // Process multipart upload
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("Multipart error: {}", e)))?
    {
        if field.name() == Some("file") {
            original_filename = field.file_name().map(|s| s.to_string());
            let data = field
                .bytes()
                .await
                .map_err(|e| ApiError::BadRequest(format!("Failed to read file: {}", e)))?;

            file_size = data.len() as i64;
            let file_path = format!("{}/dump.sql", upload_dir);

            tokio::fs::write(&file_path, &data)
                .await
                .map_err(|e| ApiError::Internal(format!("Failed to write file: {}", e)))?;
        }
    }

    // Update dump record
    sqlx::query(
        r#"
        UPDATE dumps
        SET status = $1, original_filename = $2, file_size = $3, updated_at = $4
        WHERE id = $5
        "#,
    )
    .bind(DumpStatus::Uploaded.as_str())
    .bind(&original_filename)
    .bind(file_size)
    .bind(Utc::now())
    .bind(id)
    .execute(&state.db_pool)
    .await?;

    fetch_dump_by_id(&state, id).await.map(Json)
}

/// Trigger dump restore
pub async fn restore_dump(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Dump>> {
    let dump = fetch_dump_by_id(&state, id).await?;

    if dump.status != DumpStatus::Uploaded {
        return Err(ApiError::BadRequest(format!(
            "Dump is in '{}' state, expected 'UPLOADED'",
            dump.status.as_str()
        )));
    }

    // Update status to restoring (worker will pick it up)
    sqlx::query(
        r#"
        UPDATE dumps
        SET status = $1, updated_at = $2
        WHERE id = $3
        "#,
    )
    .bind(DumpStatus::Restoring.as_str())
    .bind(Utc::now())
    .bind(id)
    .execute(&state.db_pool)
    .await?;

    fetch_dump_by_id(&state, id).await.map(Json)
}

// Helper functions

async fn fetch_dump_by_id(state: &AppState, id: Uuid) -> ApiResult<Dump> {
    let row = sqlx::query(
        r#"
        SELECT id, slug, original_filename, name, status, error_message,
               file_size, created_at, updated_at, expires_at, sandbox_db_name
        FROM dumps
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db_pool)
    .await?;

    match row {
        Some(row) => Ok(row_to_dump(&row)),
        None => Err(ApiError::NotFound(format!("Dump {} not found", id))),
    }
}

fn row_to_dump(row: &sqlx::postgres::PgRow) -> Dump {
    let status_str: String = row.get("status");
    let status = match status_str.as_str() {
        "CREATED" => DumpStatus::Created,
        "UPLOADING" => DumpStatus::Uploading,
        "UPLOADED" => DumpStatus::Uploaded,
        "RESTORING" => DumpStatus::Restoring,
        "ANALYZING" => DumpStatus::Analyzing,
        "READY" => DumpStatus::Ready,
        "ERROR" => DumpStatus::Error,
        "DELETED" => DumpStatus::Deleted,
        _ => DumpStatus::Error,
    };

    Dump {
        id: row.get("id"),
        slug: row.get("slug"),
        original_filename: row.get("original_filename"),
        name: row.get("name"),
        status,
        error_message: row.get("error_message"),
        file_size: row.get("file_size"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        expires_at: row.get("expires_at"),
        sandbox_db_name: row.get("sandbox_db_name"),
    }
}

fn slugify(input: &str) -> String {
    slug::slugify(input)
}

fn generate_short_id() -> String {
    let id = Uuid::new_v4();
    id.to_string()[..8].to_string()
}

/// Response for sandbox databases list
#[derive(Debug, Serialize)]
pub struct DatabaseListResponse {
    pub databases: Vec<String>,
    pub primary: Option<String>,
}

/// Get list of databases available in a dump
pub async fn get_dump_databases(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<DatabaseListResponse>> {
    let row = sqlx::query(
        r#"
        SELECT sandbox_db_name, sandbox_databases
        FROM dumps
        WHERE id = $1 AND status IN ('ANALYZING', 'READY')
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db_pool)
    .await?;

    match row {
        Some(row) => {
            let primary: Option<String> = row.get("sandbox_db_name");
            let databases: Option<Vec<String>> = row.get("sandbox_databases");

            let databases = databases.unwrap_or_else(|| {
                // Fallback to primary database if sandbox_databases is not set
                primary.clone().map_or(vec![], |p| vec![p])
            });

            Ok(Json(DatabaseListResponse { databases, primary }))
        }
        None => Err(ApiError::NotFound(format!(
            "Dump {} not found or not ready",
            id
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slugify() {
        assert_eq!(slugify("My Test Dump"), "my-test-dump");
        assert_eq!(slugify("Test 123"), "test-123");
    }

    #[test]
    fn test_generate_short_id() {
        let id = generate_short_id();
        assert_eq!(id.len(), 8);
    }
}
