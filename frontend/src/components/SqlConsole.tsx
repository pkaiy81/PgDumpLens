'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

interface SqlConsoleProps {
  dumpId: string;
  database?: string;
}

/** A structured output block returned by the console API. */
type Block =
  | {
      type: 'table';
      columns: string[];
      rows: (string | null)[][];
      footer?: string | null;
      expanded: boolean;
    }
  | { type: 'text'; text: string }
  | { type: 'error'; text: string }
  | { type: 'notice'; text: string };

interface ExecuteResponse {
  blocks: Block[];
  database: string;
  prompt: string;
  expanded: boolean;
  timing: boolean;
  session_ended: boolean;
  execution_ms: number;
}

interface CreateSessionResponse {
  session_id: string;
  database: string;
  prompt: string;
}

/** A single line in the terminal scrollback: an echoed input or an output block. */
type TermEntry =
  | { kind: 'input'; prompt: string; text: string }
  | { kind: 'block'; block: Block };

interface HistoryEntry {
  sql: string;
  at: number;
}

const HISTORY_LIMIT = 50;
const MAX_ENTRIES = 500;

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

/** Serialize a result table as CSV (NULL -> empty, RFC-4180 quoting). */
export function tableToCsv(columns: string[], rows: (string | null)[][]): string {
  const esc = (v: string | null): string => {
    const s = v ?? '';
    if (s.includes(',') || s.includes('\n') || s.includes('"')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const header = columns.map(esc).join(',');
  if (rows.length === 0) return header;
  const body = rows.map((r) => r.map(esc).join(',')).join('\n');
  return `${header}\n${body}`;
}

/** Serialize a result table as TSV (NULL -> empty) for spreadsheet paste. */
export function tableToTsv(columns: string[], rows: (string | null)[][]): string {
  const cell = (v: string | null): string =>
    (v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  const header = columns.map(cell).join('\t');
  if (rows.length === 0) return header;
  const body = rows.map((r) => r.map(cell).join('\t')).join('\n');
  return `${header}\n${body}`;
}

/** Serialize a result table as pretty JSON (NULL -> null). */
export function tableToJson(columns: string[], rows: (string | null)[][]): string {
  const objs = rows.map((r) => {
    const o: Record<string, string | null> = {};
    columns.forEach((c, i) => {
      o[c] = r[i] ?? null;
    });
    return o;
  });
  return JSON.stringify(objs, null, 2);
}

/** A rendered result table with hover copy buttons (CSV / TSV / JSON). */
function TableBlock({
  block,
}: {
  block: Extract<Block, { type: 'table' }>;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const doCopy = async (fmt: 'CSV' | 'TSV' | 'JSON') => {
    const text =
      fmt === 'CSV'
        ? tableToCsv(block.columns, block.rows)
        : fmt === 'TSV'
        ? tableToTsv(block.columns, block.rows)
        : tableToJson(block.columns, block.rows);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(fmt);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard unavailable; silently ignore.
    }
  };

  return (
    <div className="my-1">
      <div className="flex items-center justify-end gap-2 pb-0.5">
        {copied && (
          <span className="text-xs text-emerald-400">Copied!</span>
        )}
        <button
          type="button"
          onClick={() => doCopy('CSV')}
          className="text-xs text-slate-600 hover:text-slate-200"
        >
          Copy CSV
        </button>
        <button
          type="button"
          onClick={() => doCopy('TSV')}
          className="text-xs text-slate-600 hover:text-slate-200"
        >
          Copy TSV
        </button>
        <button
          type="button"
          onClick={() => doCopy('JSON')}
          className="text-xs text-slate-600 hover:text-slate-200"
        >
          Copy JSON
        </button>
      </div>

      {block.expanded ? (
        <div>
          {block.rows.map((row, ri) => (
            <div key={ri} className="mb-1">
              <div className="text-slate-400">{`-[ RECORD ${ri + 1} ]-`}</div>
              <table className="border-collapse">
                <tbody>
                  {block.columns.map((col, ci) => (
                    <tr key={ci}>
                      <td className="whitespace-pre px-3 align-top font-semibold">
                        {col}
                      </td>
                      <td className="whitespace-pre border-l border-slate-700 px-3 align-top">
                        {row[ci] ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ) : (
        <table className="border-collapse">
          <thead>
            <tr>
              {block.columns.map((col, ci) => (
                <th
                  key={ci}
                  className={`border-b border-slate-600 px-3 text-left font-semibold ${
                    ci > 0 ? 'border-l border-slate-700' : ''
                  }`}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri}>
                {block.columns.map((_, ci) => (
                  <td
                    key={ci}
                    className={`whitespace-pre px-3 align-top ${
                      ci > 0 ? 'border-l border-slate-700' : ''
                    }`}
                  >
                    {row[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {block.footer && <div className="text-slate-400">{block.footer}</div>}
    </div>
  );
}

export function SqlConsole({ dumpId, database }: SqlConsoleProps) {
  const [entries, setEntries] = useState<TermEntry[]>([]);
  const [buffer, setBuffer] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [db, setDb] = useState(database ?? 'sandbox');
  const [historyIndex, setHistoryIndex] = useState(-1);

  const sessionIdRef = useRef<string | null>(null);
  const historyRef = useRef<HistoryEntry[]>([]);
  const draftRef = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const appendEntries = useCallback((items: TermEntry[]) => {
    setEntries((prev) => {
      const next = [...prev, ...items];
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  }, []);

  const appendBlocks = useCallback(
    (blocks: Block[]) => {
      appendEntries(blocks.map((block) => ({ kind: 'block', block })));
    },
    [appendEntries]
  );

  const pushHistory = useCallback(
    (statement: string) => {
      const deduped = historyRef.current.filter((e) => e.sql !== statement);
      const next = [{ sql: statement, at: Date.now() }, ...deduped].slice(
        0,
        HISTORY_LIMIT
      );
      historyRef.current = next;
      saveHistory(dumpId, next);
    },
    [dumpId]
  );

  // Create a new session, updating the session ref and prompt. Returns the
  // session id and connected database name, or null on failure.
  const createSession = useCallback(async (): Promise<{
    id: string;
    database: string;
  } | null> => {
    try {
      const res = await fetch(`/api/dumps/${dumpId}/console`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ database: database ?? undefined }),
      });
      const json = (await res.json().catch(() => null)) as CreateSessionResponse | null;
      if (!res.ok || !json) return null;
      sessionIdRef.current = json.session_id;
      setDb(json.database);
      return { id: json.session_id, database: json.database };
    } catch {
      return null;
    }
  }, [dumpId, database]);

  // Session lifecycle: (re)create on dumpId/database change, tear down on unmount.
  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    setBuffer([]);
    setInput('');
    setHistoryIndex(-1);
    sessionIdRef.current = null;
    historyRef.current = loadHistory(dumpId);

    (async () => {
      const created = await createSession();
      if (cancelled) return;
      if (!created) {
        appendBlocks([
          { type: 'error', text: 'Failed to start console session.' },
        ]);
        return;
      }
      appendEntries([
        {
          kind: 'block',
          block: {
            type: 'notice',
            text: 'PgDumpLens console — psql-like sandbox terminal. Type \\? for help.',
          },
        },
        {
          kind: 'block',
          block: {
            type: 'notice',
            text: `You are connected to database "${created.database}".`,
          },
        },
      ]);
    })();

    return () => {
      cancelled = true;
      const sid = sessionIdRef.current;
      if (sid) {
        // sendBeacon cannot issue DELETE; keepalive fetch survives unload.
        fetch(`/api/console/${sid}`, {
          method: 'DELETE',
          keepalive: true,
        }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dumpId, database]);

  // Auto-scroll to the newest line.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  // Refocus the input once a command finishes running (disabling the input
  // during execution causes the browser to drop focus from it).
  useEffect(() => {
    if (!running && !window.getSelection()?.toString()) {
      inputRef.current?.focus();
    }
  }, [running]);

  const postInput = async (
    sid: string,
    text: string
  ): Promise<{ status: number; ok: boolean; json: ExecuteResponse | null }> => {
    const res = await fetch(`/api/console/${sid}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text }),
    });
    const json = (await res.json().catch(() => null)) as ExecuteResponse | null;
    return { status: res.status, ok: res.ok, json };
  };

  const submit = useCallback(
    async (text: string) => {
      pushHistory(text);
      setRunning(true);
      try {
        let sid = sessionIdRef.current;
        if (sid === null) {
          const created = await createSession();
          if (created === null) {
            appendBlocks([
              { type: 'error', text: 'No active console session.' },
            ]);
            return;
          }
          sid = created.id;
        }

        let res = await postInput(sid, text);

        // Session expired: recreate once, notify, and retry the same input.
        if (res.status === 404) {
          const created = await createSession();
          if (created === null) {
            appendBlocks([
              { type: 'error', text: 'Console session not found or expired.' },
            ]);
            return;
          }
          appendBlocks([
            { type: 'notice', text: 'Session expired — reconnected.' },
          ]);
          res = await postInput(created.id, text);
          if (res.status === 404) {
            appendBlocks([
              { type: 'error', text: 'Console session not found or expired.' },
            ]);
            return;
          }
        }

        if (res.status === 409) {
          appendBlocks([
            {
              type: 'error',
              text: 'Console session is busy — wait for the current command to finish.',
            },
          ]);
          return;
        }

        if (!res.ok || !res.json) {
          const message =
            (res.json &&
              (res.json as unknown as { message?: string }).message) ||
            'Command failed.';
          appendBlocks([{ type: 'error', text: message }]);
          return;
        }

        appendBlocks(res.json.blocks);
        setDb(res.json.database);
        if (res.json.session_ended) {
          sessionIdRef.current = null;
          appendBlocks([
            {
              type: 'notice',
              text: 'Session ended. A new session starts on your next command.',
            },
          ]);
        }
      } catch {
        appendBlocks([{ type: 'error', text: 'Command failed.' }]);
      } finally {
        setRunning(false);
      }
    },
    [pushHistory, createSession, appendBlocks]
  );

  const promptFor = (continuation: boolean): string =>
    continuation ? `${db}-#` : `${db}=#`;

  const handleEnter = () => {
    if (running) return;
    const line = input;
    const echoPrompt = promptFor(buffer.length > 0);
    appendEntries([{ kind: 'input', prompt: echoPrompt, text: line }]);
    setInput('');
    setHistoryIndex(-1);

    // Empty line with an empty buffer is a no-op (psql): echo the prompt only.
    if (buffer.length === 0 && line.trim() === '') {
      return;
    }

    // Meta-commands (`\`-prefixed) run immediately, even mid-continuation, and
    // leave the continuation buffer untouched (psql behavior).
    if (line.trimStart().startsWith('\\')) {
      submit(line.trim());
      return;
    }

    const nextBuffer = [...buffer, line];
    if (line.trimEnd().endsWith(';')) {
      setBuffer([]);
      submit(nextBuffer.join('\n'));
    } else {
      setBuffer(nextBuffer);
    }
  };

  const handleCtrlC = () => {
    const echoPrompt = promptFor(buffer.length > 0);
    appendEntries([{ kind: 'input', prompt: echoPrompt, text: `${input}^C` }]);
    setInput('');
    setBuffer([]);
    setHistoryIndex(-1);
  };

  const navHistory = (dir: 1 | -1) => {
    const hist = historyRef.current;
    if (hist.length === 0) return;
    if (dir === 1) {
      // Older.
      let idx = historyIndex;
      if (idx === -1) {
        draftRef.current = input;
        idx = 0;
      } else {
        idx = Math.min(idx + 1, hist.length - 1);
      }
      setInput(hist[idx].sql);
      setHistoryIndex(idx);
    } else {
      // Newer.
      if (historyIndex === -1) return;
      const idx = historyIndex - 1;
      if (idx < 0) {
        setInput(draftRef.current);
        setHistoryIndex(-1);
      } else {
        setInput(hist[idx].sql);
        setHistoryIndex(idx);
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleEnter();
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      handleCtrlC();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      navHistory(1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      navHistory(-1);
    }
  };

  return (
    <div className="space-y-2">
      {/* Thin amber note. */}
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
        Runs against a disposable sandbox. \? for help, statements end with ;
      </div>

      {/* Dark terminal panel. */}
      <div
        ref={scrollRef}
        onClick={() => {
          // Don't steal focus (which clears the selection) mid-selection so
          // drag-select + copy works.
          if (window.getSelection()?.toString()) return;
          inputRef.current?.focus();
        }}
        className="h-[calc(100vh-26rem)] min-h-[26rem] overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100"
      >
        {entries.map((entry, i) => {
          if (entry.kind === 'input') {
            return (
              <div key={i} className="whitespace-pre-wrap">
                <span className="mr-2 text-emerald-400">{entry.prompt}</span>
                {entry.text}
              </div>
            );
          }
          const b = entry.block;
          if (b.type === 'table') {
            return <TableBlock key={i} block={b} />;
          }
          if (b.type === 'error') {
            return (
              <pre key={i} className="whitespace-pre-wrap text-red-400">
                {b.text}
              </pre>
            );
          }
          if (b.type === 'notice') {
            return (
              <pre key={i} className="whitespace-pre-wrap text-slate-400">
                {b.text}
              </pre>
            );
          }
          return (
            <pre key={i} className="whitespace-pre">
              {b.text}
            </pre>
          );
        })}

        {/* Prompt / input line. */}
        <div className="flex items-start">
          {running ? (
            <span className="mr-2 text-slate-500">...</span>
          ) : (
            <span className="mr-2 text-emerald-400">
              {promptFor(buffer.length > 0)}
            </span>
          )}
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={running}
            className="flex-1 border-none bg-transparent font-mono text-slate-100 outline-none"
            autoFocus
            spellCheck={false}
            aria-label="Terminal input"
          />
        </div>
      </div>
    </div>
  );
}
