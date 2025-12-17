'use client';

import { useState, useEffect } from 'react';

interface DataTableProps {
  dumpId: string;
  schema: string;
  table: string;
  database?: string;
  onCellClick?: (column: string, value: unknown, row: Record<string, unknown>) => void;
}

interface TableData {
  columns: string[];
  rows: Record<string, unknown>[];
  total_count: number;
}

export function DataTable({ dumpId, schema, table, database, onCellClick }: DataTableProps) {
  const [data, setData] = useState<TableData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 50;

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        let url = `/api/dumps/${dumpId}/tables/${table}?schema=${encodeURIComponent(schema)}&limit=${pageSize}&offset=${page * pageSize}`;
        if (database) {
          url += `&database=${encodeURIComponent(database)}`;
        }
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error('Failed to load table data');
        }
        const json = await res.json();
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error loading data');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [dumpId, schema, table, database, page]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin w-8 h-8 border-2 border-indigo-200 border-t-indigo-600 rounded-full"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-red-500 py-4 text-center">{error}</div>
    );
  }

  if (!data || data.rows.length === 0) {
    return (
      <div className="text-slate-500 dark:text-slate-400 py-8 text-center">No data available</div>
    );
  }

  const totalPages = Math.ceil(data.total_count / pageSize);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="data-table w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-700">
              {data.columns.map((col) => (
                <th key={col} className="text-left py-2 px-3 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/50">
                {data.columns.map((col) => (
                  <td
                    key={col}
                    onClick={() => onCellClick?.(col, row[col], row)}
                    className="py-2 px-3 font-mono text-xs cursor-pointer hover:bg-indigo-50 dark:hover:bg-indigo-900/30 whitespace-nowrap max-w-xs truncate"
                    title={formatCellValue(row[col])}
                  >
                    {formatCellValue(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Showing {page * pageSize + 1} - {Math.min((page + 1) * pageSize, data.total_count)} of {data.total_count}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="px-3 py-1 text-sm border border-slate-200 dark:border-slate-600 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              Previous
            </button>
            <span className="px-3 py-1 text-sm text-slate-600 dark:text-slate-400">
              Page {page + 1} of {totalPages}
            </span>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
              className="px-3 py-1 text-sm border border-slate-200 dark:border-slate-600 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

