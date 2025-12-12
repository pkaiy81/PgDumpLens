//! Job processing logic

use chrono::Utc;
use sqlx::{postgres::PgPool, Row};
use tracing::{error, info};
use uuid::Uuid;

use crate::config::WorkerConfig;
use db_viewer_core::adapter::DbAdapter;
use db_viewer_core::domain::DumpStatus;

/// Process pending restore and analysis jobs
pub async fn process_pending_jobs<A: DbAdapter>(
    db_pool: &PgPool,
    adapter: &A,
    config: &WorkerConfig,
) -> anyhow::Result<usize> {
    let mut processed = 0;

    // Process RESTORING jobs
    let restoring_jobs = fetch_jobs_by_status(db_pool, DumpStatus::Restoring).await?;
    for dump_id in restoring_jobs {
        match process_restore(db_pool, adapter, config, dump_id).await {
            Ok(_) => {
                info!("Successfully restored dump {}", dump_id);
                processed += 1;
            }
            Err(e) => {
                error!("Failed to restore dump {}: {}", dump_id, e);
                mark_error(db_pool, dump_id, &e.to_string()).await?;
            }
        }
    }

    // Process ANALYZING jobs
    let analyzing_jobs = fetch_jobs_by_status(db_pool, DumpStatus::Analyzing).await?;
    for dump_id in analyzing_jobs {
        match process_analysis(db_pool, adapter, config, dump_id).await {
            Ok(_) => {
                info!("Successfully analyzed dump {}", dump_id);
                processed += 1;
            }
            Err(e) => {
                error!("Failed to analyze dump {}: {}", dump_id, e);
                mark_error(db_pool, dump_id, &e.to_string()).await?;
            }
        }
    }

    Ok(processed)
}

async fn fetch_jobs_by_status(pool: &PgPool, status: DumpStatus) -> anyhow::Result<Vec<Uuid>> {
    let rows =
        sqlx::query("SELECT id FROM dumps WHERE status = $1 ORDER BY updated_at ASC LIMIT 10")
            .bind(status.as_str())
            .fetch_all(pool)
            .await?;

    Ok(rows.iter().map(|row| row.get("id")).collect())
}

async fn process_restore<A: DbAdapter>(
    db_pool: &PgPool,
    adapter: &A,
    config: &WorkerConfig,
    dump_id: Uuid,
) -> anyhow::Result<()> {
    info!("Processing restore for dump {}", dump_id);

    let dump_path = format!("{}/{}/dump.sql", config.upload_dir, dump_id);
    let sandbox_db_name = format!("sandbox_{}", dump_id.to_string().replace('-', "_"));

    // Restore the dump
    adapter.restore_dump(&dump_path, &sandbox_db_name).await?;

    // Update status to ANALYZING
    sqlx::query(
        r#"
        UPDATE dumps
        SET status = $1, sandbox_db_name = $2, updated_at = $3
        WHERE id = $4
        "#,
    )
    .bind(DumpStatus::Analyzing.as_str())
    .bind(&sandbox_db_name)
    .bind(Utc::now())
    .bind(dump_id)
    .execute(db_pool)
    .await?;

    Ok(())
}

async fn process_analysis<A: DbAdapter>(
    db_pool: &PgPool,
    adapter: &A,
    _config: &WorkerConfig,
    dump_id: Uuid,
) -> anyhow::Result<()> {
    info!("Processing analysis for dump {}", dump_id);

    // Get sandbox database name
    let row = sqlx::query("SELECT sandbox_db_name FROM dumps WHERE id = $1")
        .bind(dump_id)
        .fetch_one(db_pool)
        .await?;

    let sandbox_db: String = row.get("sandbox_db_name");

    // Build schema graph
    let schema_graph = adapter.build_schema_graph(&sandbox_db).await?;

    // Store schema graph in metadata
    sqlx::query(
        r#"
        INSERT INTO dump_schemas (dump_id, schema_graph, created_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (dump_id) DO UPDATE
        SET schema_graph = $2, created_at = $3
        "#,
    )
    .bind(dump_id)
    .bind(serde_json::to_value(&schema_graph)?)
    .bind(Utc::now())
    .execute(db_pool)
    .await?;

    // Update status to READY
    sqlx::query(
        r#"
        UPDATE dumps
        SET status = $1, updated_at = $2
        WHERE id = $3
        "#,
    )
    .bind(DumpStatus::Ready.as_str())
    .bind(Utc::now())
    .bind(dump_id)
    .execute(db_pool)
    .await?;

    Ok(())
}

async fn mark_error(pool: &PgPool, dump_id: Uuid, error_message: &str) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        UPDATE dumps
        SET status = $1, error_message = $2, updated_at = $3
        WHERE id = $4
        "#,
    )
    .bind(DumpStatus::Error.as_str())
    .bind(error_message)
    .bind(Utc::now())
    .bind(dump_id)
    .execute(pool)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sandbox_db_name_format() {
        let id = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();
        let name = format!("sandbox_{}", id.to_string().replace('-', "_"));
        assert_eq!(name, "sandbox_550e8400_e29b_41d4_a716_446655440000");
    }
}
