-- Add sandbox_databases column to support multiple databases from pg_dumpall dumps
-- This replaces sandbox_db_name for dumps that contain multiple databases

ALTER TABLE dumps ADD COLUMN IF NOT EXISTS sandbox_databases TEXT[];

-- Migrate existing data: convert sandbox_db_name to sandbox_databases array
UPDATE dumps 
SET sandbox_databases = ARRAY[sandbox_db_name]
WHERE sandbox_db_name IS NOT NULL AND sandbox_databases IS NULL;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_dumps_sandbox_databases ON dumps USING GIN (sandbox_databases);
