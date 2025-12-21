-- 003_multi_database_schemas.sql
-- Support multiple databases (pg_dumpall)

-- Drop existing primary key
ALTER TABLE dump_schemas DROP CONSTRAINT dump_schemas_pkey;

-- Add database_name column
ALTER TABLE dump_schemas ADD COLUMN database_name VARCHAR(255);

-- For existing rows, set database_name from dumps.sandbox_db_name  
UPDATE dump_schemas ds
SET database_name = COALESCE(
    (SELECT sandbox_db_name FROM dumps WHERE id = ds.dump_id),
    ''
);

-- Make database_name NOT NULL
ALTER TABLE dump_schemas ALTER COLUMN database_name SET NOT NULL;

-- Add new composite primary key
ALTER TABLE dump_schemas ADD PRIMARY KEY (dump_id, database_name);

-- Add index for faster lookups
CREATE INDEX idx_dump_schemas_dump_id ON dump_schemas(dump_id);
