-- Add excluded_tables column to support selective restore
-- This column stores a list of tables that should be excluded during restore

ALTER TABLE dumps ADD COLUMN IF NOT EXISTS excluded_tables TEXT[] DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN dumps.excluded_tables IS 'List of tables to exclude from restore (format: schema.table_name)';
