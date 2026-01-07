'use client';

import React, { useState } from 'react';
import {
  SchemaDiffResponse,
  TableDiff,
  ColumnDiff,
  ChangeType,
} from '@/types';

interface DiffViewerProps {
  diff: SchemaDiffResponse;
  onClose?: () => void;
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

function TableDiffCard({ tableDiff }: { tableDiff: TableDiff }) {
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

export default function DiffViewer({ diff, onClose }: DiffViewerProps) {
  const [filter, setFilter] = useState<ChangeType | 'all'>('all');
  
  const filteredTables = diff.table_diffs.filter(
    (t) => filter === 'all' || t.change_type === filter
  );
  
  const filteredFks = diff.fk_diffs.filter(
    (fk) => filter === 'all' || fk.change_type === filter
  );
  
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
      <div className="flex gap-2 mb-4">
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
      </div>
      
      {/* Table Diffs */}
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
            />
          ))
        )}
      </div>
      
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
