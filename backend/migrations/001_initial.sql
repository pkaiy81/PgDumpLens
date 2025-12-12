-- DB Viewer Metadata Schema
-- Initial migration

-- Dumps table
CREATE TABLE IF NOT EXISTS dumps (
    id UUID PRIMARY KEY,
    slug VARCHAR(255) NOT NULL UNIQUE,
    original_filename VARCHAR(500),
    name VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'CREATED',
    error_message TEXT,
    file_size BIGINT,
    sandbox_db_name VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- Index for slug lookups
CREATE INDEX idx_dumps_slug ON dumps(slug) WHERE status != 'DELETED';

-- Index for status-based job queries
CREATE INDEX idx_dumps_status ON dumps(status, updated_at);

-- Index for TTL cleanup
CREATE INDEX idx_dumps_expires_at ON dumps(expires_at) WHERE status != 'DELETED';

-- Schema cache table
CREATE TABLE IF NOT EXISTS dump_schemas (
    dump_id UUID PRIMARY KEY REFERENCES dumps(id) ON DELETE CASCADE,
    schema_graph JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Value statistics cache (for suggestions)
CREATE TABLE IF NOT EXISTS value_stats (
    id SERIAL PRIMARY KEY,
    dump_id UUID NOT NULL REFERENCES dumps(id) ON DELETE CASCADE,
    schema_name VARCHAR(255) NOT NULL,
    table_name VARCHAR(255) NOT NULL,
    column_name VARCHAR(255) NOT NULL,
    top_values JSONB,
    null_count BIGINT,
    distinct_count BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(dump_id, schema_name, table_name, column_name)
);

CREATE INDEX idx_value_stats_lookup ON value_stats(dump_id, schema_name, table_name, column_name);

-- Job queue for async processing (optional, alternative to polling)
CREATE TABLE IF NOT EXISTS job_queue (
    id SERIAL PRIMARY KEY,
    dump_id UUID NOT NULL REFERENCES dumps(id) ON DELETE CASCADE,
    job_type VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    payload JSONB,
    result JSONB,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_job_queue_pending ON job_queue(status, created_at) WHERE status = 'PENDING';
