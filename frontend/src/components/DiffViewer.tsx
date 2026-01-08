'use client';

import React, { useState } from 'react';
import {
  SchemaDiffResponse,
  TableDiff,
  ColumnDiff,
  ChangeType,
  TableDataDiffResponse,
} from '@/types';
import DataDiffViewer from './DataDiffViewer';

interface TableSummary {
  schema_name: string;
  table_name: string;
  estimated_row_count: number | null;
}

interface DiffViewerProps {
  diff: SchemaDiffResponse;
  onClose?: () => void;
  onViewTableData?: (schema: string, table: string) => Promise<TableDataDiffResponse | null>;
  /** All tables from the base schema, for comparing tables not detected in schema diff */
  allTables?: TableSummary[];
}

const changeTypeColors: Record<ChangeType, { bg: string; text: string; border: string }> = {
  added: { bg: 'bg-green-100 dark:bg-green-900/40', text: 'text-green-800 dark:text-green-300', border: 'border-green-300 dark:border-green-700' },
  removed: { bg: 'bg-red-100 dark:bg-red-900/40', text: 'text-red-800 dark:text-red-300', border: 'border-red-300 dark:border-red-700' },
  modified: { bg: 'bg-yellow-100 dark:bg-yellow-900/40', text: 'text-yellow-800 dark:text-yellow-300', border: 'border-yellow-300 dark:border-yellow-700' },
};

const changeTypeLabels: Record<ChangeType, { en: string; ja: string }> = {
  added: { en: 'Added', ja: '追加' },
  removed: { en: 'Removed', ja: '削除' },
  modified: { en: 'Modified', ja: '変更' },
};

function ChangeTypeBadge({ type }: { type: ChangeType }) {
  const colors = changeTypeColors[type];
  const label = changeTypeLabels[type];
  
  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded ${colors.bg} ${colors.text}`}>
      {label.en}
    </span>
  );
}

function DiffSummaryCard({ diff }: { diff: SchemaDiffResponse }) {
  const { summary } = diff;
  
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow p-4 mb-6">
      <h3 className="text-lg font-semibold mb-3 text-gray-800 dark:text-slate-200">Diff Summary</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <div className="p-3 bg-green-50 dark:bg-green-900/30 rounded">
          <div className="text-green-700 dark:text-green-400 font-medium">Added</div>
          <div className="text-2xl font-bold text-green-800 dark:text-green-300">{summary.tables_added}</div>
          <div className="text-green-600 dark:text-green-400/80">tables, {summary.columns_added} columns</div>
        </div>
        <div className="p-3 bg-red-50 dark:bg-red-900/30 rounded">
          <div className="text-red-700 dark:text-red-400 font-medium">Removed</div>
          <div className="text-2xl font-bold text-red-800 dark:text-red-300">{summary.tables_removed}</div>
          <div className="text-red-600 dark:text-red-400/80">tables, {summary.columns_removed} columns</div>
        </div>
        <div className="p-3 bg-yellow-50 dark:bg-yellow-900/30 rounded">
          <div className="text-yellow-700 dark:text-yellow-400 font-medium">Modified</div>
          <div className="text-2xl font-bold text-yellow-800 dark:text-yellow-300">{summary.tables_modified}</div>
          <div className="text-yellow-600 dark:text-yellow-400/80">tables, {summary.columns_modified} columns</div>
        </div>
        <div className="p-3 bg-blue-50 dark:bg-blue-900/30 rounded">
          <div className="text-blue-700 dark:text-blue-400 font-medium">Row Count</div>
          <div className={`text-2xl font-bold ${summary.row_count_change >= 0 ? 'text-green-800 dark:text-green-300' : 'text-red-800 dark:text-red-300'}`}>
            {summary.row_count_change >= 0 ? '+' : ''}{summary.row_count_change}
          </div>
          <div className="text-blue-600 dark:text-blue-400/80">net change</div>
        </div>
      </div>
      {(summary.fk_added > 0 || summary.fk_removed > 0) && (
        <div className="mt-3 pt-3 border-t border-gray-200 dark:border-slate-700 text-sm text-gray-600 dark:text-slate-400">
          Foreign Keys: +{summary.fk_added} / -{summary.fk_removed}
        </div>
      )}
    </div>
  );
}

function ColumnDiffRow({ columnDiff }: { columnDiff: ColumnDiff }) {
  const colors = changeTypeColors[columnDiff.change_type];
  
  return (
    <tr className={`${colors.bg} ${colors.border}`}>
      <td className="px-3 py-2 border-b border-gray-200 dark:border-slate-700">
        <ChangeTypeBadge type={columnDiff.change_type} />
      </td>
      <td className="px-3 py-2 border-b border-gray-200 dark:border-slate-700 font-mono text-sm text-gray-800 dark:text-slate-200">
        {columnDiff.column_name}
      </td>
      <td className="px-3 py-2 border-b border-gray-200 dark:border-slate-700 text-sm">
        {columnDiff.base_info ? (
          <span className="text-gray-600 dark:text-slate-400">
            {columnDiff.base_info.data_type}
            {columnDiff.base_info.is_primary_key && ' 🔑'}
            {!columnDiff.base_info.is_nullable && ' NOT NULL'}
          </span>
        ) : (
          <span className="text-gray-400 dark:text-slate-500">—</span>
        )}
      </td>
      <td className="px-3 py-2 border-b border-gray-200 dark:border-slate-700 text-sm">
        {columnDiff.compare_info ? (
          <span className="text-gray-600 dark:text-slate-400">
            {columnDiff.compare_info.data_type}
            {columnDiff.compare_info.is_primary_key && ' 🔑'}
            {!columnDiff.compare_info.is_nullable && ' NOT NULL'}
          </span>
        ) : (
          <span className="text-gray-400 dark:text-slate-500">—</span>
        )}
      </td>
    </tr>
  );
}

function TableDiffCard({ tableDiff, onViewData }: { tableDiff: TableDiff; onViewData?: () => void }) {
  const [expanded, setExpanded] = useState(tableDiff.change_type !== 'removed');
  const colors = changeTypeColors[tableDiff.change_type];
  
  const rowCountChange = 
    (tableDiff.compare_row_count ?? 0) - (tableDiff.base_row_count ?? 0);
  
  return (
    <div className={`border rounded-lg mb-3 ${colors.border}`}>
      <div
        className={`flex items-center justify-between p-3 cursor-pointer ${colors.bg} rounded-t-lg`}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <ChangeTypeBadge type={tableDiff.change_type} />
          <span className="font-mono font-medium text-gray-800 dark:text-slate-200">
            {tableDiff.schema_name}.{tableDiff.table_name}
          </span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          {onViewData && tableDiff.change_type !== 'added' && tableDiff.change_type !== 'removed' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onViewData();
              }}
              className="px-2 py-1 text-xs font-medium bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 rounded hover:bg-indigo-200 dark:hover:bg-indigo-900/70 transition-colors"
            >
              📊 View Data Diff
            </button>
          )}
          <span className="text-gray-600 dark:text-slate-400">
            {tableDiff.base_row_count ?? '—'} → {tableDiff.compare_row_count ?? '—'} rows
            {rowCountChange !== 0 && (
              <span className={rowCountChange > 0 ? 'text-green-600 dark:text-green-400 ml-1' : 'text-red-600 dark:text-red-400 ml-1'}>
                ({rowCountChange > 0 ? '+' : ''}{rowCountChange})
              </span>
            )}
          </span>
          <span className="text-gray-400 dark:text-slate-500">
            {expanded ? '▼' : '▶'}
          </span>
        </div>
      </div>
      
      {expanded && tableDiff.column_diffs.length > 0 && (
        <div className="p-3 bg-white dark:bg-slate-800 rounded-b-lg overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-xs text-gray-500 dark:text-slate-400 uppercase">
                <th className="px-3 py-2 border-b border-gray-200 dark:border-slate-700 w-24">Change</th>
                <th className="px-3 py-2 border-b border-gray-200 dark:border-slate-700">Column</th>
                <th className="px-3 py-2 border-b border-gray-200 dark:border-slate-700">Before</th>
                <th className="px-3 py-2 border-b border-gray-200 dark:border-slate-700">After</th>
              </tr>
            </thead>
            <tbody>
              {tableDiff.column_diffs.map((cd) => (
                <ColumnDiffRow key={cd.column_name} columnDiff={cd} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      
      {expanded && tableDiff.column_diffs.length === 0 && tableDiff.change_type === 'modified' && (
        <div className="p-3 bg-white dark:bg-slate-800 rounded-b-lg text-sm text-gray-500 dark:text-slate-400">
          Only row count changed, no schema modifications.
        </div>
      )}
    </div>
  );
}

export default function DiffViewer({ diff, onClose, onViewTableData, allTables }: DiffViewerProps) {
  const [filter, setFilter] = useState<ChangeType | 'all' | 'data-only' | 'check-all'>('all');
  const [selectedTableDataDiff, setSelectedTableDataDiff] = useState<TableDataDiffResponse | null>(null);
  const [loadingDataDiff, setLoadingDataDiff] = useState(false);
  const [dataDiffError, setDataDiffError] = useState<string | null>(null);
  
  // Tables with schema changes
  const schemaChangedTables = diff.table_diffs.filter(
    (t) => t.change_type !== 'modified' || t.column_diffs.length > 0
  );
  
  // Tables with no schema changes (unchanged schema, but might have data changes)
  const unchangedSchemaTables = diff.table_diffs.filter(
    (t) => t.change_type === 'modified' && t.column_diffs.length === 0
  );
  
  // Tables with data-only changes (no schema changes but row count differs)
  const dataOnlyTables = diff.table_diffs.filter(
    (t) => t.change_type === 'modified' && t.column_diffs.length === 0 && t.has_data_change
  );
  
  // Tables that exist in schema but not in diff (unchanged tables)
  const tablesInDiff = new Set(
    diff.table_diffs.map((t) => `${t.schema_name}.${t.table_name}`)
  );
  const unchangedTables: TableSummary[] = (allTables || []).filter(
    (t) => !tablesInDiff.has(`${t.schema_name}.${t.table_name}`)
  );
  
  const filteredTables = diff.table_diffs.filter(
    (t) => {
      if (filter === 'all') return true;
      if (filter === 'data-only') {
        return t.change_type === 'modified' && t.column_diffs.length === 0 && t.has_data_change;
      }
      if (filter === 'check-all') return false; // Don't show diff tables in check-all mode
      return t.change_type === filter;
    }
  );
  
  const filteredFks = diff.fk_diffs.filter(
    (fk) => filter === 'all' || fk.change_type === filter
  );
  
  const handleViewTableData = async (schema: string, table: string) => {
    if (!onViewTableData) return;
    
    setLoadingDataDiff(true);
    setDataDiffError(null);
    try {
      const dataDiff = await onViewTableData(schema, table);
      if (dataDiff) {
        setSelectedTableDataDiff(dataDiff);
      } else {
        setDataDiffError('Failed to fetch data diff. The table may not exist in both dumps.');
      }
    } catch (err) {
      setDataDiffError(err instanceof Error ? err.message : 'Failed to fetch data diff');
    } finally {
      setLoadingDataDiff(false);
    }
  };
  
  // If viewing data diff, show that instead
  if (selectedTableDataDiff) {
    return (
      <div className="max-w-6xl mx-auto p-4">
        <button
          onClick={() => setSelectedTableDataDiff(null)}
          className="mb-4 px-3 py-1 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors flex items-center gap-2"
        >
          ← Back to Schema Diff
        </button>
        <DataDiffViewer 
          diff={selectedTableDataDiff} 
          onClose={() => setSelectedTableDataDiff(null)} 
        />
      </div>
    );
  }
  
  if (loadingDataDiff) {
    return (
      <div className="max-w-6xl mx-auto p-4 text-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500 mx-auto mb-4"></div>
        <p className="text-slate-500 dark:text-slate-400">Loading data diff...</p>
      </div>
    );
  }
  
  if (dataDiffError) {
    return (
      <div className="max-w-6xl mx-auto p-4">
        <button
          onClick={() => {
            setDataDiffError(null);
            setFilter('all');
          }}
          className="mb-4 px-3 py-1 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors flex items-center gap-2"
        >
          ← Back to Schema Diff
        </button>
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6 text-center">
          <div className="text-4xl mb-2">⚠️</div>
          <p className="text-red-600 dark:text-red-400 mb-2">Failed to load data diff</p>
          <p className="text-sm text-red-500 dark:text-red-500">{dataDiffError}</p>
        </div>
      </div>
    );
  }
  
  return (
    <div className="max-w-6xl mx-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-gray-800 dark:text-slate-200">
          Schema Diff
        </h2>
        {onClose && (
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            ✕ Close
          </button>
        )}
      </div>
      
      <div className="text-sm text-gray-600 dark:text-slate-400 mb-4">
        Comparing database: <span className="font-mono">{diff.database_name}</span>
      </div>
      
      <DiffSummaryCard diff={diff} />
      
      {/* Filter */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <button
          onClick={() => setFilter('all')}
          className={`px-3 py-1 rounded text-sm ${
            filter === 'all'
              ? 'bg-gray-800 dark:bg-slate-200 text-white dark:text-slate-900'
              : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600'
          }`}
        >
          All ({diff.table_diffs.length})
        </button>
        <button
          onClick={() => setFilter('added')}
          className={`px-3 py-1 rounded text-sm ${
            filter === 'added'
              ? 'bg-green-600 text-white'
              : 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/70'
          }`}
        >
          Added ({diff.table_diffs.filter((t) => t.change_type === 'added').length})
        </button>
        <button
          onClick={() => setFilter('removed')}
          className={`px-3 py-1 rounded text-sm ${
            filter === 'removed'
              ? 'bg-red-600 text-white'
              : 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/70'
          }`}
        >
          Removed ({diff.table_diffs.filter((t) => t.change_type === 'removed').length})
        </button>
        <button
          onClick={() => setFilter('modified')}
          className={`px-3 py-1 rounded text-sm ${
            filter === 'modified'
              ? 'bg-yellow-600 text-white'
              : 'bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-200 dark:hover:bg-yellow-900/70'
          }`}
        >
          Modified ({diff.table_diffs.filter((t) => t.change_type === 'modified').length})
        </button>
        {dataOnlyTables.length > 0 && (
          <button
            onClick={() => setFilter('data-only')}
            className={`px-3 py-1 rounded text-sm ${
              filter === 'data-only'
                ? 'bg-indigo-600 text-white'
                : 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-200 dark:hover:bg-indigo-900/70'
            }`}
          >
            📊 Data Changed ({dataOnlyTables.length})
          </button>
        )}
        {unchangedTables.length > 0 && onViewTableData && (
          <button
            onClick={() => setFilter('check-all')}
            className={`px-3 py-1 rounded text-sm ${
              filter === 'check-all'
                ? 'bg-purple-600 text-white'
                : 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300 hover:bg-purple-200 dark:hover:bg-purple-900/70'
            }`}
          >
            🔍 Check All Tables ({unchangedTables.length})
          </button>
        )}
      </div>
      
      {/* Info message when no changes */}
      {diff.table_diffs.length === 0 && filter !== 'check-all' && (
        <div className="text-center py-12 bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
          <div className="text-6xl mb-4">✓</div>
          <p className="text-lg font-medium text-slate-700 dark:text-slate-300 mb-2">
            No schema or data changes detected
          </p>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Both dumps have identical table structures and row counts.
            {unchangedTables.length > 0 && onViewTableData && (
              <> Click &quot;Check All Tables&quot; to compare row data for tables with no detected changes.</>
            )}
          </p>
        </div>
      )}
      
      {/* Data-only changes info message */}
      {filter === 'data-only' && dataOnlyTables.length > 0 && (
        <div className="mb-4 p-4 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-lg">
          <p className="text-sm text-indigo-800 dark:text-indigo-300">
            💡 <strong>Data Changes Only:</strong> These tables have <strong>row count differences</strong> but no schema changes (same columns, types, constraints).
          </p>
          <p className="text-sm text-indigo-700 dark:text-indigo-400 mt-2">
            Click &quot;View Data Diff&quot; to see detailed row-level changes.
          </p>
        </div>
      )}
      
      {/* Check All Tables mode - show unchanged tables */}
      {filter === 'check-all' && unchangedTables.length > 0 && (
        <div className="mb-6">
          <div className="mb-4 p-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg">
            <p className="text-sm text-purple-800 dark:text-purple-300">
              🔍 <strong>Check All Tables:</strong> These tables have <strong>no detected schema or row count changes</strong>, but data content may have changed.
            </p>
            <p className="text-sm text-purple-700 dark:text-purple-400 mt-2">
              Click &quot;View Data Diff&quot; to compare actual row data and find content-level changes.
            </p>
          </div>
          <h3 className="text-lg font-semibold text-gray-700 dark:text-slate-300 mb-3">
            Unchanged Tables ({unchangedTables.length})
          </h3>
          <div className="space-y-2">
            {unchangedTables.map((table) => (
              <div
                key={`${table.schema_name}.${table.table_name}`}
                className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <span className="px-2 py-0.5 text-xs font-medium rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-400">
                    unchanged
                  </span>
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    {table.schema_name}.{table.table_name}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-slate-500 dark:text-slate-400">
                    {table.estimated_row_count ?? '—'} rows
                  </span>
                  {onViewTableData && (
                    <button
                      onClick={() => handleViewTableData(table.schema_name, table.table_name)}
                      className="px-2 py-1 text-xs font-medium bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300 rounded hover:bg-purple-200 dark:hover:bg-purple-900/70 transition-colors"
                    >
                      📊 View Data Diff
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* Table Diffs */}
      {diff.table_diffs.length > 0 && filter !== 'check-all' && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-gray-700 dark:text-slate-300 mb-3">
            Tables ({filteredTables.length})
          </h3>
          {filteredTables.length === 0 ? (
            <div className="text-gray-500 dark:text-slate-400 text-sm">No table changes in this category.</div>
          ) : (
            filteredTables.map((tableDiff) => (
              <TableDiffCard
                key={`${tableDiff.schema_name}.${tableDiff.table_name}`}
                tableDiff={tableDiff}
                onViewData={onViewTableData ? () => handleViewTableData(tableDiff.schema_name, tableDiff.table_name) : undefined}
              />
            ))
          )}
        </div>
      )}
      
      {/* Foreign Key Diffs */}
      {filteredFks.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-gray-700 dark:text-slate-300 mb-3">
            Foreign Keys ({filteredFks.length})
          </h3>
          <div className="bg-white dark:bg-slate-800 rounded-lg shadow overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 dark:bg-slate-700">
                <tr>
                  <th className="px-4 py-2 text-gray-600 dark:text-slate-300">Change</th>
                  <th className="px-4 py-2 text-gray-600 dark:text-slate-300">Constraint</th>
                  <th className="px-4 py-2 text-gray-600 dark:text-slate-300">Source → Target</th>
                </tr>
              </thead>
              <tbody>
                {filteredFks.map((fk) => {
                  const colors = changeTypeColors[fk.change_type];
                  return (
                    <tr key={fk.constraint_name} className={colors.bg}>
                      <td className="px-4 py-2 border-t border-gray-200 dark:border-slate-700">
                        <ChangeTypeBadge type={fk.change_type} />
                      </td>
                      <td className="px-4 py-2 border-t border-gray-200 dark:border-slate-700 font-mono text-gray-800 dark:text-slate-200">
                        {fk.constraint_name}
                      </td>
                      <td className="px-4 py-2 border-t border-gray-200 dark:border-slate-700 text-gray-700 dark:text-slate-300">
                        {fk.source_table} → {fk.target_table}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
