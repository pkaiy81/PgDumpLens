// Type definitions for PgDumpLens

export interface DumpSummary {
  id: string;
  slug: string;
  name: string | null;
  status: DumpStatus;
  file_size: number | null;
  created_at: string;
  expires_at: string;
}

export interface Dump extends DumpSummary {
  original_filename: string | null;
  error_message: string | null;
  updated_at: string;
  sandbox_db_name: string | null;
}

export type DumpStatus =
  | 'CREATED'
  | 'UPLOADING'
  | 'UPLOADED'
  | 'RESTORING'
  | 'ANALYZING'
  | 'READY'
  | 'ERROR'
  | 'DELETED';

export interface TableInfo {
  schema_name: string;
  table_name: string;
  estimated_row_count: number;
  columns: ColumnInfo[];
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  is_nullable: boolean;
  is_primary_key: boolean;
  default_value: string | null;
}

export interface ForeignKey {
  constraint_name: string;
  source_schema: string;
  source_table: string;
  source_columns: string[];
  target_schema: string;
  target_table: string;
  target_columns: string[];
  on_delete: FkAction;
  on_update: FkAction;
}

export type FkAction =
  | 'NO_ACTION'
  | 'RESTRICT'
  | 'CASCADE'
  | 'SET_NULL'
  | 'SET_DEFAULT';

export interface SchemaGraph {
  tables: TableInfo[];
  foreign_keys: ForeignKey[];
}

export interface SchemaResponse {
  schema_graph: SchemaGraph;
  mermaid_er: string;
}

export interface RiskScore {
  score: number;
  level: RiskLevel;
  reasons: string[];
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RelationExplanation {
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
  direction: 'inbound' | 'outbound';
  path_length: number;
  sample_rows: unknown[];
  sql_example: string;
  risk_score: number;
  risk_reasons: string[];
}

export interface TableDataResponse {
  schema: string;
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  total_count: number;
  limit: number;
  offset: number;
}

export interface DatabaseListResponse {
  databases: string[];
  primary: string | null;
}

// ==================== Diff Types ====================

export type ChangeType = 'added' | 'removed' | 'modified';

export interface DiffSummary {
  tables_added: number;
  tables_removed: number;
  tables_modified: number;
  columns_added: number;
  columns_removed: number;
  columns_modified: number;
  fk_added: number;
  fk_removed: number;
  row_count_change: number;
}

export interface ColumnDiffInfo {
  data_type: string;
  is_nullable: boolean;
  is_primary_key: boolean;
  default_value: string | null;
}

export interface ColumnDiff {
  column_name: string;
  change_type: ChangeType;
  base_info: ColumnDiffInfo | null;
  compare_info: ColumnDiffInfo | null;
}

export interface TableDiff {
  schema_name: string;
  table_name: string;
  change_type: ChangeType;
  base_row_count: number | null;
  compare_row_count: number | null;
  column_diffs: ColumnDiff[];
  has_data_change?: boolean;
}

export interface ForeignKeyDiff {
  constraint_name: string;
  change_type: ChangeType;
  source_table: string;
  target_table: string;
  fk_info: ForeignKey | null;
}

export interface SchemaDiffResponse {
  base_dump_id: string;
  compare_dump_id: string;
  database_name: string;
  summary: DiffSummary;
  table_diffs: TableDiff[];
  fk_diffs: ForeignKeyDiff[];
}

// ==================== Data Diff Types ====================

export interface RowDiff {
  pk: unknown;
  change_type: 'added' | 'removed' | 'modified';
  base_values: Record<string, unknown> | null;
  compare_values: Record<string, unknown> | null;
  changed_columns: string[];
}

export interface TableDataDiffResponse {
  base_dump_id: string;
  compare_dump_id: string;
  schema_name: string;
  table_name: string;
  primary_key_columns: string[];
  total_added: number;
  total_removed: number;
  total_modified: number;
  rows: RowDiff[];
  truncated: boolean;
}
