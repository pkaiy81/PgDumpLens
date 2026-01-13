'use client';

import { useState, useEffect, useCallback } from 'react';

interface ColumnRelationInfo {
  hasOutbound: boolean;  // This column references another table
  hasInbound: boolean;   // This column is referenced by other tables
  outboundTables: string[];  // List of tables this column references
  inboundTables: string[];   // List of tables that reference this column
}

interface DataTableProps {
  dumpId: string;
  schema: string;
  table: string;
  database?: string;
  columnRelations?: Record<string, ColumnRelationInfo>;
  onCellClick?: (column: string, value: unknown, row: Record<string, unknown>) => void;
}

interface TableData {
  columns: string[];
  rows: Record<string, unknown>[];
  total_count: number;
}

interface SuggestItem {
  value: unknown;
  frequency: number;
  source: string;
}

interface ColumnFilter {
  column: string;
  value: string;
}

export function DataTable({ dumpId, schema, table, database, columnRelations, onCellClick }: DataTableProps) {
  const [data, setData] = useState<TableData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 50;

  // Filter state
  const [activeFilter, setActiveFilter] = useState<ColumnFilter | null>(null);
  const [filterInput, setFilterInput] = useState('');
  const [suggestions, setSuggestions] = useState<SuggestItem[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);

  // Transpose state
  const [isTransposed, setIsTransposed] = useState(false);

  // Copy state
  const [copySuccess, setCopySuccess] = useState<string | null>(null);
  const [showCopyMenu, setShowCopyMenu] = useState(false);

  // Fetch suggestions for a column
  const fetchSuggestions = useCallback(async (column: string, prefix: string) => {
    setSuggestLoading(true);
    try {
      let url = `/api/dumps/${dumpId}/suggest?table=${encodeURIComponent(table)}&column=${encodeURIComponent(column)}&schema=${encodeURIComponent(schema)}&limit=10`;
      if (prefix) {
        url += `&prefix=${encodeURIComponent(prefix)}`;
      }
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        setSuggestions(json.suggestions || []);
      }
    } catch {
      setSuggestions([]);
    } finally {
      setSuggestLoading(false);
    }
  }, [dumpId, table, schema]);

  // Handle filter column click
  const handleFilterClick = (column: string) => {
    if (activeFilter?.column === column) {
      // Close filter
      setActiveFilter(null);
      setShowSuggestions(false);
      setSuggestions([]);
    } else {
      // Open filter for this column
      setActiveFilter({ column, value: '' });
      setFilterInput('');
      setShowSuggestions(true);
      fetchSuggestions(column, '');
    }
  };

  // Handle filter input change
  const handleFilterInputChange = (value: string) => {
    setFilterInput(value);
    if (activeFilter) {
      fetchSuggestions(activeFilter.column, value);
    }
  };

  // Apply filter
  const applyFilter = (value: string) => {
    if (activeFilter) {
      setActiveFilter({ ...activeFilter, value });
      setShowSuggestions(false);
      setPage(0);
    }
  };

  // Clear filter
  const clearFilter = () => {
    setActiveFilter(null);
    setFilterInput('');
    setSuggestions([]);
    setShowSuggestions(false);
    setPage(0);
  };

  // Helper function to copy text to clipboard with fallback
  const copyToClipboard = useCallback(async (text: string): Promise<boolean> => {
    // Try modern clipboard API first
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        console.warn('Clipboard API failed, trying fallback:', err);
      }
    }
    // Fallback for non-HTTPS or older browsers
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      textArea.style.top = '-9999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const success = document.execCommand('copy');
      document.body.removeChild(textArea);
      return success;
    } catch (err) {
      console.error('Fallback copy failed:', err);
      return false;
    }
  }, []);

  // Copy data as CSV
  const copyAsCSV = useCallback(async () => {
    if (!data) return;
    // Compute filtered rows inline
    const rows = activeFilter?.value
      ? data.rows.filter((row) => {
          const cellValue = formatCellValue(row[activeFilter.column]);
          return cellValue.toLowerCase().includes(activeFilter.value.toLowerCase());
        })
      : data.rows;
    
    let csv: string;
    if (isTransposed) {
      // Transposed: columns become rows, each row becomes a column
      // Header is "Column" followed by row indices (or "Row 1", "Row 2", etc.)
      const header = ['Column', ...rows.map((_, i) => `Row ${i + 1}`)].join(',');
      const csvRows = data.columns.map(col => {
        const values = rows.map(row => {
          const val = formatCellValue(row[col]);
          if (val.includes(',') || val.includes('\n') || val.includes('"')) {
            return `"${val.replace(/"/g, '""')}"`;
          }
          return val;
        });
        return [col, ...values].join(',');
      });
      csv = [header, ...csvRows].join('\n');
    } else {
      // Normal: standard row-based CSV
      const header = data.columns.join(',');
      const csvRows = rows.map(row => 
        data.columns.map(col => {
          const val = formatCellValue(row[col]);
          // Escape quotes and wrap in quotes if contains comma or newline
          if (val.includes(',') || val.includes('\n') || val.includes('"')) {
            return `"${val.replace(/"/g, '""')}"`;
          }
          return val;
        }).join(',')
      );
      csv = [header, ...csvRows].join('\n');
    }
    const success = await copyToClipboard(csv);
    if (success) {
      setCopySuccess('CSV');
      setTimeout(() => setCopySuccess(null), 2000);
    }
  }, [data, activeFilter, copyToClipboard, isTransposed]);

  // Copy data as JSON
  const copyAsJSON = useCallback(async () => {
    if (!data) return;
    // Compute filtered rows inline
    const rows = activeFilter?.value
      ? data.rows.filter((row) => {
          const cellValue = formatCellValue(row[activeFilter.column]);
          return cellValue.toLowerCase().includes(activeFilter.value.toLowerCase());
        })
      : data.rows;
    
    let jsonData: unknown;
    if (isTransposed) {
      // Transposed: structure as { column: [row1val, row2val, ...] }
      jsonData = data.columns.reduce((acc, col) => {
        acc[col] = rows.map(row => row[col]);
        return acc;
      }, {} as Record<string, unknown[]>);
    } else {
      // Normal: array of row objects
      jsonData = rows;
    }
    const json = JSON.stringify(jsonData, null, 2);
    const success = await copyToClipboard(json);
    if (success) {
      setCopySuccess('JSON');
      setTimeout(() => setCopySuccess(null), 2000);
    }
  }, [data, activeFilter, copyToClipboard, isTransposed]);

  // Copy single cell value
  const copyCellValue = useCallback(async (value: unknown) => {
    const text = formatCellValue(value);
    const success = await copyToClipboard(text);
    if (success) {
      setCopySuccess('Cell');
      setTimeout(() => setCopySuccess(null), 1500);
    }
  }, [copyToClipboard]);

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

  // Apply client-side filter
  const filteredRows = activeFilter?.value
    ? data.rows.filter((row) => {
        const cellValue = formatCellValue(row[activeFilter.column]);
        return cellValue.toLowerCase().includes(activeFilter.value.toLowerCase());
      })
    : data.rows;

  const totalPages = Math.ceil((activeFilter?.value ? filteredRows.length : data.total_count) / pageSize);
  const displayedRows = activeFilter?.value
    ? filteredRows.slice(page * pageSize, (page + 1) * pageSize)
    : filteredRows;

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-3 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          {/* Active Filter Badge */}
          {activeFilter?.value && (
            <span className="inline-flex items-center gap-1 px-2 py-1 bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 rounded-lg text-sm">
              <span className="font-medium">{activeFilter.column}</span>
              <span>=</span>
              <span className="font-mono">&quot;{activeFilter.value}&quot;</span>
              <button
                onClick={clearFilter}
                className="ml-1 hover:text-indigo-900 dark:hover:text-indigo-100"
              >
                ✕
              </button>
              <span className="text-slate-500 ml-1">({filteredRows.length} matches)</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Copy success message */}
          {copySuccess && (
            <span className="text-sm text-green-600 dark:text-green-400 animate-pulse">
              ✓ Copied as {copySuccess}
            </span>
          )}

          {/* Transpose toggle */}
          <button
            onClick={() => setIsTransposed(!isTransposed)}
            className={`px-3 py-1.5 text-sm rounded-lg border transition-colors flex items-center gap-1.5 ${
              isTransposed
                ? 'bg-indigo-100 dark:bg-indigo-900/50 border-indigo-300 dark:border-indigo-600 text-indigo-700 dark:text-indigo-300'
                : 'bg-white dark:bg-slate-700 border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-600'
            }`}
            title="Toggle row/column transpose"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
            </svg>
            Transpose
          </button>

          {/* Copy dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowCopyMenu(!showCopyMenu)}
              onBlur={() => setTimeout(() => setShowCopyMenu(false), 150)}
              className="px-3 py-1.5 text-sm rounded-lg border bg-white dark:bg-slate-700 border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Copy
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showCopyMenu && (
              <div className="absolute right-0 mt-1 w-36 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-600 z-50">
                <button
                  onMouseDown={(e) => { e.preventDefault(); copyAsCSV(); setShowCopyMenu(false); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 rounded-t-lg"
                >
                  📋 Copy as CSV
                </button>
                <button
                  onMouseDown={(e) => { e.preventDefault(); copyAsJSON(); setShowCopyMenu(false); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 rounded-b-lg"
                >
                  📋 Copy as JSON
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Transposed View */}
      {isTransposed ? (
        <div className="overflow-x-auto">
          <table className="data-table w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700">
                <th className="text-left py-2 px-3 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap bg-slate-50 dark:bg-slate-800/50 min-w-[150px] sticky left-0">
                  Column
                </th>
                {displayedRows.map((_, rowIdx) => (
                  <th key={rowIdx} className="text-left py-2 px-3 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">
                    Row {page * pageSize + rowIdx + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.columns.map((col) => {
                const relInfo = columnRelations?.[col];
                const hasRelations = relInfo?.hasOutbound || relInfo?.hasInbound;
                
                return (
                  <tr key={col} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/50">
                    <th className="relative text-left py-2 px-3 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap bg-slate-50 dark:bg-slate-800/50 min-w-[150px] sticky left-0">
                      <div className="flex items-center gap-1">
                        {relInfo?.hasInbound && (
                          <span className="text-blue-500 dark:text-blue-400" title={`Referenced by: ${relInfo.inboundTables.join(', ')}`}>⬅️</span>
                        )}
                        {relInfo?.hasOutbound && (
                          <span className="text-purple-500 dark:text-purple-400" title={`References: ${relInfo.outboundTables.join(', ')}`}>🔗</span>
                        )}
                        <span className={hasRelations ? 'font-semibold text-slate-700 dark:text-slate-200' : ''}>{col}</span>
                        <button
                          onClick={() => handleFilterClick(col)}
                          className={`p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 ${activeFilter?.column === col ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400'}`}
                          title={`Filter by ${col}`}
                        >
                          🔍
                        </button>
                      </div>
                      {/* Filter dropdown */}
                      {activeFilter?.column === col && showSuggestions && (
                        <div className="absolute z-50 mt-1 left-0 w-64 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-600">
                          <div className="p-2">
                            <input
                              type="text"
                              value={filterInput}
                              onChange={(e) => handleFilterInputChange(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && filterInput) {
                                  applyFilter(filterInput);
                                } else if (e.key === 'Escape') {
                                  setShowSuggestions(false);
                                }
                              }}
                              placeholder={`Filter ${col}...`}
                              className="w-full px-2 py-1 text-sm border border-slate-200 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                              autoFocus
                            />
                          </div>
                          <div className="max-h-48 overflow-y-auto border-t border-slate-200 dark:border-slate-600">
                            {suggestLoading ? (
                              <div className="p-2 text-center text-slate-500 text-sm">Loading...</div>
                            ) : suggestions.length > 0 ? (
                              <>
                                <div className="px-2 py-1 text-xs text-slate-400 bg-slate-50 dark:bg-slate-700/50">
                                  Top values
                                </div>
                                {suggestions.map((s, i) => (
                                  <button
                                    key={i}
                                    onClick={() => applyFilter(formatCellValue(s.value))}
                                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 flex justify-between items-center"
                                  >
                                    <span className="font-mono truncate">{formatCellValue(s.value)}</span>
                                    <span className="text-xs text-slate-400 ml-2">({s.frequency})</span>
                                  </button>
                                ))}
                              </>
                            ) : (
                              <div className="p-2 text-center text-slate-500 text-sm">Type to search</div>
                            )}
                          </div>
                        </div>
                      )}
                    </th>
                    {displayedRows.map((row, rowIdx) => (
                      <td
                        key={rowIdx}
                        onClick={() => onCellClick?.(col, row[col], row)}
                        onDoubleClick={() => copyCellValue(row[col])}
                        className="py-2 px-3 font-mono text-xs cursor-pointer hover:bg-indigo-50 dark:hover:bg-indigo-900/30 whitespace-nowrap max-w-xs truncate"
                        title={`${formatCellValue(row[col])}\n\nDouble-click to copy`}
                      >
                        {formatCellValue(row[col])}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-2 text-center">
            💡 Double-click a cell to copy its value
          </p>
        </div>
      ) : (
        /* Normal Table View */
        <div className="overflow-x-auto">
          <table className="data-table w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700">
                {data.columns.map((col) => {
                  const relInfo = columnRelations?.[col];
                  const hasRelations = relInfo?.hasOutbound || relInfo?.hasInbound;
                  
                  return (
                  <th key={col} className="relative text-left py-2 px-3 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">
                    <div className="flex items-center gap-1">
                      {/* Relation indicators */}
                      {relInfo?.hasInbound && (
                        <span 
                          className="text-blue-500 dark:text-blue-400" 
                          title={`Referenced by: ${relInfo.inboundTables.join(', ')}`}
                        >
                          ⬅️
                        </span>
                      )}
                      {relInfo?.hasOutbound && (
                        <span 
                          className="text-purple-500 dark:text-purple-400" 
                          title={`References: ${relInfo.outboundTables.join(', ')}`}
                        >
                          🔗
                        </span>
                      )}
                      <span className={hasRelations ? 'font-semibold text-slate-700 dark:text-slate-200' : ''}>{col}</span>
                      <button
                        onClick={() => handleFilterClick(col)}
                        className={`p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 ${
                          activeFilter?.column === col ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400'
                        }`}
                        title={`Filter by ${col}`}
                      >
                        🔍
                      </button>
                    </div>
                    {/* Filter dropdown */}
                    {activeFilter?.column === col && showSuggestions && (
                      <div className="absolute z-50 mt-1 w-64 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-600">
                        <div className="p-2">
                          <input
                            type="text"
                            value={filterInput}
                            onChange={(e) => handleFilterInputChange(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && filterInput) {
                                applyFilter(filterInput);
                              } else if (e.key === 'Escape') {
                                setShowSuggestions(false);
                              }
                            }}
                            placeholder={`Filter ${col}...`}
                            className="w-full px-2 py-1 text-sm border border-slate-200 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                            autoFocus
                          />
                        </div>
                        <div className="max-h-48 overflow-y-auto border-t border-slate-200 dark:border-slate-600">
                          {suggestLoading ? (
                            <div className="p-2 text-center text-slate-500 text-sm">Loading...</div>
                          ) : suggestions.length > 0 ? (
                            <>
                              <div className="px-2 py-1 text-xs text-slate-400 bg-slate-50 dark:bg-slate-700/50">
                                Top values
                              </div>
                              {suggestions.map((s, i) => (
                                <button
                                  key={i}
                                  onClick={() => applyFilter(formatCellValue(s.value))}
                                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 flex justify-between items-center"
                                >
                                  <span className="font-mono truncate">{formatCellValue(s.value)}</span>
                                  <span className="text-xs text-slate-400 ml-2">({s.frequency})</span>
                                </button>
                              ))}
                            </>
                          ) : (
                            <div className="p-2 text-center text-slate-500 text-sm">Type to search</div>
                          )}
                        </div>
                      </div>
                    )}
                  </th>
                );
                })}
              </tr>
            </thead>
            <tbody>
              {displayedRows.map((row, rowIdx) => (
                <tr key={rowIdx} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/50">
                  {data.columns.map((col) => (
                    <td
                      key={col}
                      onClick={() => onCellClick?.(col, row[col], row)}
                      onDoubleClick={() => copyCellValue(row[col])}
                      className="py-2 px-3 font-mono text-xs cursor-pointer hover:bg-indigo-50 dark:hover:bg-indigo-900/30 whitespace-nowrap max-w-xs truncate"
                      title={`${formatCellValue(row[col])}\n\nDouble-click to copy`}
                    >
                      {formatCellValue(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-2 text-center">
            💡 Double-click a cell to copy its value
          </p>
        </div>
      )}
      
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

