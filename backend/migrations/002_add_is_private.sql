-- Add is_private column to dumps table
-- Private dumps are not shown in the "Recent Dumps" list

ALTER TABLE dumps ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;

-- Index for private flag (optimize list queries)
CREATE INDEX IF NOT EXISTS idx_dumps_is_private ON dumps(is_private) WHERE status != 'DELETED';
