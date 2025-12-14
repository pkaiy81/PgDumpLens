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
