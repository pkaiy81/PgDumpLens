'use client';

import { useState, useCallback, useEffect } from 'react';
import { formatCellValue } from './DataTable';

interface SqlConsoleProps {
  dumpId: string;
  database?: string;
}

interface QueryResult {
  kind: 'rows' | 'command';
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  rows_affected: number | null;
  execution_ms: number;
}

interface HistoryEntry {
  sql: string;
  at: number;
}

const HISTORY_LIMIT = 50;

function historyKey(dumpId: string): string {
  return `pgdumplens:sql-history:${dumpId}`;
}

function loadHistory(dumpId: string): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(historyKey(dumpId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (e) => e && typeof e.sql === 'string' && typeof e.at === 'number'
      );
    }
    return [];
  } catch {
    return [];
  }
}

function saveHistory(dumpId: string, entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(historyKey(dumpId), JSON.stringify(entries));
  } catch {
    // Ignore storage errors (private mode, quota, etc.).
  }
}

export function SqlConsole({ dumpId, database }: SqlConsoleProps) {
  const [sql, setSql] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    setHistory(loadHistory(dumpId));
  }, [dumpId]);

  const pushHistory = useCallback(
    (statement: string) => {
      setHistory((prev) => {
        const deduped = prev.filter((e) => e.sql !== statement);
        const next = [{ sql: statement, at: Date.now() }, ...deduped].slice(
          0,
          HISTORY_LIMIT
        );
        saveHistory(dumpId, next);
        return next;
      });
    },
    [dumpId]
  );

  const runQuery = useCallback(async () => {
    const trimmed = sql.trim();
    if (!trimmed || running) return;

    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/dumps/${dumpId}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: trimmed, database }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          (json && typeof json.message === 'string' && json.message) ||
            'Query failed'
        );
        return;
      }
      setResult(json as QueryResult);
      pushHistory(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Query failed');
    } finally {
      setRunning(false);
    }
  }, [sql, running, dumpId, database, pushHistory]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      runQuery();
    }
  };

  return (
    <div className="space-y-4">
      {/* Warning banner */}
      <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
        Queries run against a disposable sandbox. Writes and DDL are allowed and
        affect only this sandbox. One statement per run.
      </div>

      {/* Editor */}
      <div>
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={8}
          spellCheck={false}
          placeholder="SELECT * FROM ...   (Ctrl/Cmd+Enter to run — one statement per run)"
          className="w-full font-mono text-sm px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={runQuery}
            disabled={running || !sql.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running && (
              <span className="animate-spin w-4 h-4 border-2 border-white/40 border-t-white rounded-full" />
            )}
            {running ? 'Running...' : 'Run'}
          </button>
          <span className="text-xs text-slate-400">Ctrl/Cmd+Enter</span>
          {history.length > 0 && (
            <button
              onClick={() => setShowHistory((v) => !v)}
              className="ml-auto text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            >
              {showHistory ? 'Hide' : 'Show'} history ({history.length})
            </button>
          )}
        </div>
      </div>

      {/* History */}
      {showHistory && history.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700 max-h-56 overflow-y-auto">
          {history.map((entry, i) => (
            <button
              key={`${entry.at}-${i}`}
              onClick={() => setSql(entry.sql)}
              className="block w-full text-left px-3 py-2 text-xs font-mono truncate hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
              title={entry.sql}
            >
              {entry.sql}
            </button>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 px-4 py-3 text-sm text-red-700 dark:text-red-300 font-mono whitespace-pre-wrap">
          {error}
        </div>
      )}

      {/* Command result */}
      {result && result.kind === 'command' && (
        <div className="rounded-lg border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/30 px-4 py-3 text-sm text-green-700 dark:text-green-300">
          {result.rows_affected ?? 0} row(s) affected ({result.execution_ms} ms)
        </div>
      )}

      {/* Rows result */}
      {result && result.kind === 'rows' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400">
            <span>
              {result.row_count} row{result.row_count === 1 ? '' : 's'}
            </span>
            <span>{result.execution_ms} ms</span>
          </div>
          {result.truncated && (
            <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-4 py-2 text-sm text-amber-800 dark:text-amber-200">
              Results were truncated to {result.row_count} rows. Use a smaller
              query or LIMIT to see the rest.
            </div>
          )}
          {result.columns.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="data-table w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-700">
                    {result.columns.map((col) => (
                      <th
                        key={col}
                        className="text-left py-2 px-3 text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, rowIdx) => (
                    <tr
                      key={rowIdx}
                      className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/50"
                    >
                      {result.columns.map((col) => (
                        <td
                          key={col}
                          className="py-2 px-3 font-mono text-xs whitespace-nowrap max-w-xs truncate"
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
          ) : (
            <div className="text-slate-500 dark:text-slate-400 py-4 text-center">
              No rows returned
            </div>
          )}
        </div>
      )}
    </div>
  );
}
