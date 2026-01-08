'use client';

import React, { useState } from 'react';
import { TableDataDiffResponse, RowDiff } from '@/types';

interface DataDiffViewerProps {
  diff: TableDataDiffResponse;
  onClose?: () => void;
}

const changeTypeColors = {
  added: {
    bg: 'bg-green-50 dark:bg-green-900/30',
    border: 'border-green-200 dark:border-green-800',
    text: 'text-green-700 dark:text-green-400',
    badge: 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300',
  },
  removed: {
    bg: 'bg-red-50 dark:bg-red-900/30',
    border: 'border-red-200 dark:border-red-800',
    text: 'text-red-700 dark:text-red-400',
    badge: 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300',
  },
  modified: {
    bg: 'bg-yellow-50 dark:bg-yellow-900/30',
    border: 'border-yellow-200 dark:border-yellow-800',
    text: 'text-yellow-700 dark:text-yellow-400',
    badge: 'bg-yellow-100 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-300',
  },
};

function formatValue(value: unknown): string {
  if (value === null) return 'NULL';
  if (value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function RowDiffCard({ row, primaryKeyColumns, allColumnsAsPK }: { row: RowDiff; primaryKeyColumns: string[]; allColumnsAsPK: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const colors = changeTypeColors[row.change_type];
  
  const pkDisplay = typeof row.pk === 'object' 
    ? JSON.stringify(row.pk) 
    : String(row.pk);

  const values = row.base_values || row.compare_values || {};
  // If all columns are used as PK (no real PK), show all columns
  // Otherwise, show only non-PK columns
  const columns = allColumnsAsPK 
    ? Object.keys(values)
    : Object.keys(values).filter(c => !primaryKeyColumns.includes(c));

  return (
    <div className={`border rounded-lg mb-2 ${colors.border}`}>
      <div
        className={`flex items-center justify-between p-3 cursor-pointer ${colors.bg} rounded-t-lg`}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <span className={`px-2 py-0.5 text-xs font-medium rounded ${colors.badge}`}>
            {row.change_type === 'added' ? '+' : row.change_type === 'removed' ? '-' : '~'}
          </span>
          <span className="font-mono text-sm text-slate-700 dark:text-slate-300">
            PK: {pkDisplay}
          </span>
          {row.change_type === 'modified' && row.changed_columns.length > 0 && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              ({row.changed_columns.length} column{row.changed_columns.length > 1 ? 's' : ''} changed)
            </span>
          )}
        </div>
        <span className="text-slate-400 dark:text-slate-500">
          {expanded ? '▼' : '▶'}
        </span>
      </div>
      
      {expanded && (
        <div className="p-3 bg-white dark:bg-slate-800 rounded-b-lg overflow-x-auto">
          {row.change_type === 'modified' ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 dark:text-slate-400 uppercase">
                  <th className="px-3 py-2 text-left border-b border-slate-200 dark:border-slate-700">Column</th>
                  <th className="px-3 py-2 text-left border-b border-slate-200 dark:border-slate-700 bg-red-50 dark:bg-red-900/20">Before</th>
                  <th className="px-3 py-2 text-left border-b border-slate-200 dark:border-slate-700 bg-green-50 dark:bg-green-900/20">After</th>
                </tr>
              </thead>
              <tbody>
                {columns.map(col => {
                  const isChanged = row.changed_columns.includes(col);
                  const baseVal = row.base_values?.[col];
                  const compareVal = row.compare_values?.[col];
                  
                  if (!isChanged) return null;
                  
                  return (
                    <tr key={col} className="hover:bg-slate-50 dark:hover:bg-slate-700/50">
                      <td className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 font-mono font-medium text-slate-700 dark:text-slate-300">
                        {col}
                      </td>
                      <td className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-red-50/50 dark:bg-red-900/10 font-mono text-red-700 dark:text-red-400">
                        {formatValue(baseVal)}
                      </td>
                      <td className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-green-50/50 dark:bg-green-900/10 font-mono text-green-700 dark:text-green-400">
                        {formatValue(compareVal)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 dark:text-slate-400 uppercase">
                  <th className="px-3 py-2 text-left border-b border-slate-200 dark:border-slate-700">Column</th>
                  <th className="px-3 py-2 text-left border-b border-slate-200 dark:border-slate-700">Value</th>
                </tr>
              </thead>
              <tbody>
                {columns.map(col => {
                  const val = (row.base_values || row.compare_values)?.[col];
                  return (
                    <tr key={col} className="hover:bg-slate-50 dark:hover:bg-slate-700/50">
                      <td className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 font-mono font-medium text-slate-700 dark:text-slate-300">
                        {col}
                      </td>
                      <td className={`px-3 py-2 border-b border-slate-200 dark:border-slate-700 font-mono ${colors.text}`}>
                        {formatValue(val)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export default function DataDiffViewer({ diff, onClose }: DataDiffViewerProps) {
  const [filter, setFilter] = useState<'all' | 'added' | 'removed' | 'modified'>('all');
  
  const filteredRows = diff.rows.filter(
    r => filter === 'all' || r.change_type === filter
  );
  
  const totalChanges = diff.total_added + diff.total_removed + diff.total_modified;
  
  // Detect if all columns are used as PK (table has no real primary key)
  // In this case, primary_key_columns will contain all column names
  const sampleRow = diff.rows[0]?.base_values || diff.rows[0]?.compare_values;
  const allColumnsAsPK = sampleRow 
    ? Object.keys(sampleRow).length === diff.primary_key_columns.length
    : diff.primary_key_columns.length > 5; // Heuristic: more than 5 "PK" columns suggests all columns as key
  
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
            Data Diff: {diff.schema_name}.{diff.table_name}
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {allColumnsAsPK 
              ? 'No Primary Key (comparing by all columns)'
              : `Primary Key: ${diff.primary_key_columns.join(', ')}`}
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="px-3 py-1 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
          >
            ✕ Close
          </button>
        )}
      </div>
      
      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="p-4 bg-green-50 dark:bg-green-900/30 rounded-lg border border-green-200 dark:border-green-800">
          <div className="text-2xl font-bold text-green-700 dark:text-green-400">+{diff.total_added}</div>
          <div className="text-sm text-green-600 dark:text-green-500">Rows Added</div>
        </div>
        <div className="p-4 bg-red-50 dark:bg-red-900/30 rounded-lg border border-red-200 dark:border-red-800">
          <div className="text-2xl font-bold text-red-700 dark:text-red-400">-{diff.total_removed}</div>
          <div className="text-sm text-red-600 dark:text-red-500">Rows Removed</div>
        </div>
        <div className="p-4 bg-yellow-50 dark:bg-yellow-900/30 rounded-lg border border-yellow-200 dark:border-yellow-800">
          <div className="text-2xl font-bold text-yellow-700 dark:text-yellow-400">~{diff.total_modified}</div>
          <div className="text-sm text-yellow-600 dark:text-yellow-500">Rows Modified</div>
        </div>
      </div>
      
      {totalChanges === 0 ? (
        <div className="text-center py-12 bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
          <div className="text-6xl mb-4">✓</div>
          <p className="text-lg font-medium text-slate-700 dark:text-slate-300 mb-2">
            No data changes detected
          </p>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Both dumps have identical data in this table
          </p>
        </div>
      ) : (
        <>
          {/* Filter */}
          <div className="flex gap-2">
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1 rounded text-sm ${
                filter === 'all'
                  ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900'
                  : 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
              }`}
            >
              All ({diff.rows.length})
            </button>
            <button
              onClick={() => setFilter('added')}
              className={`px-3 py-1 rounded text-sm ${
                filter === 'added'
                  ? 'bg-green-600 text-white'
                  : 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/70'
              }`}
            >
              Added ({diff.rows.filter(r => r.change_type === 'added').length})
            </button>
            <button
              onClick={() => setFilter('removed')}
              className={`px-3 py-1 rounded text-sm ${
                filter === 'removed'
                  ? 'bg-red-600 text-white'
                  : 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/70'
              }`}
            >
              Removed ({diff.rows.filter(r => r.change_type === 'removed').length})
            </button>
            <button
              onClick={() => setFilter('modified')}
              className={`px-3 py-1 rounded text-sm ${
                filter === 'modified'
                  ? 'bg-yellow-600 text-white'
                  : 'bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-200 dark:hover:bg-yellow-900/70'
              }`}
            >
              Modified ({diff.rows.filter(r => r.change_type === 'modified').length})
            </button>
          </div>
          
          {/* Row diffs */}
          <div className="space-y-2">
            {filteredRows.map((row, idx) => (
              <RowDiffCard
                key={`${row.change_type}-${JSON.stringify(row.pk)}-${idx}`}
                row={row}
                primaryKeyColumns={diff.primary_key_columns}
                allColumnsAsPK={allColumnsAsPK}
              />
            ))}
          </div>
          
          {diff.truncated && (
            <div className="text-center text-sm text-slate-500 dark:text-slate-400 py-4">
              ⚠️ Results truncated. Showing first {diff.rows.length} of {totalChanges} total changes.
            </div>
          )}
        </>
      )}
    </div>
  );
}
