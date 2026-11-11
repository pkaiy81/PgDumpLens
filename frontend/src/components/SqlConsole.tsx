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

/** Characters that may appear inside an unquoted identifier. */
function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_$\u0080-\uffff]/.test(c);
}

/**
 * Split buffered console input at its last top-level `;`, like psql decides
 * when to send a query. Semicolons inside '...' / E'...' strings, "..."
 * identifiers, $tag$...$tag$ dollar quotes, -- and nested block comments, and
 * parentheses do not count.
 *
 * Returns `complete` = the text up to and including the last top-level `;`
 * (null if there is none, or the input ends inside a quote/comment) and
 * `rest` = whatever follows it, or '' if that is only whitespace/comments.
 */
export function splitCompleteInput(text: string): {
  complete: string | null;
  rest: string;
} {
  const n = text.length;
  let i = 0;
  let depth = 0;
  let lastSemi = -1;
  let significantAfter = false;
  let open = false; // ended inside an unterminated quote / comment

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '-' && next === '-') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === '/' && next === '*') {
      let d = 0;
      let j = i;
      while (j < n) {
        if (text[j] === '/' && text[j + 1] === '*') {
          d++;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          d--;
          j += 2;
          if (d === 0) break;
        } else {
          j++;
        }
      }
      if (d > 0) open = true;
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      significantAfter = true;
      const backslash =
        c === "'" && (text[i - 1] === 'E' || text[i - 1] === 'e') && !isIdentChar(text[i - 2]);
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (backslash && text[j] === '\\') {
          j += 2;
        } else if (text[j] === c) {
          if (text[j + 1] === c) {
            j += 2;
          } else {
            j++;
            closed = true;
            break;
          }
        } else {
          j++;
        }
      }
      if (!closed) open = true;
      i = Math.min(j, n);
      continue;
    }
    if (c === '$' && !isIdentChar(text[i - 1])) {
      const m = text.slice(i).match(/^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/);
      if (m) {
        significantAfter = true;
        const tag = m[0];
        const end = text.indexOf(tag, i + tag.length);
        if (end === -1) {
          open = true;
          i = n;
        } else {
          i = end + tag.length;
        }
        continue;
      }
    }
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
    } else if (c === ';' && depth === 0) {
      lastSemi = i;
      significantAfter = false;
      i++;
      continue;
    }
    if (!/\s/.test(c)) significantAfter = true;
    i++;
  }

  if (lastSemi === -1) return { complete: null, rest: text };
  return {
    complete: text.slice(0, lastSemi + 1),
    rest: significantAfter || open ? text.slice(lastSemi + 1).trimStart() : '',
  };
}

/**
 * Feed one entered line into the continuation buffer, psql-style.
 *  - `\`-commands are sent at once and leave the buffer untouched;
 *  - an empty line with an empty buffer does nothing;
 *  - otherwise the line is buffered and everything up to the last top-level
 *    `;` is sent (see {@link splitCompleteInput}), keeping any remainder.
 */
export function processLine(
  buffer: string[],
  line: string
): { buffer: string[]; submit: string | null } {
  if (line.trimStart().startsWith('\\')) {
    return { buffer, submit: line.trim() };
  }
  if (buffer.length === 0 && line.trim() === '') {
    return { buffer, submit: null };
  }
  const next = [...buffer, line];
  const { complete, rest } = splitCompleteInput(next.join('\n'));
  if (complete === null) return { buffer: next, submit: null };
  return { buffer: rest === '' ? [] : rest.split('\n'), submit: complete };
}

/** SQL keywords offered by tab completion (in addition to schema names). */
export const SQL_KEYWORDS: string[] = [
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'LIMIT', 'OFFSET', 'JOIN',
  'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'ON', 'AS', 'AND', 'OR',
  'NOT', 'NULL', 'IN', 'IS', 'EXISTS', 'BETWEEN', 'LIKE', 'ILIKE', 'DISTINCT',
  'HAVING', 'UNION', 'ALL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'INSERT',
  'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'INDEX',
  'VIEW', 'DROP', 'ALTER', 'WITH', 'RETURNING', 'COUNT', 'SUM', 'AVG', 'MIN',
  'MAX',
];

const SQL_KEYWORD_SET = new Set(SQL_KEYWORDS);

/** Result of attempting tab completion on the current input. */
export type CompleteResult =
  | { kind: 'replace'; newInput: string }
  | { kind: 'candidates'; list: string[] }
  | { kind: 'none' };

/** Longest common prefix of a non-empty list of strings (as-is casing). */
function longestCommonPrefix(items: string[]): string {
  if (items.length === 0) return '';
  let prefix = items[0];
  for (const s of items.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === '') break;
  }
  return prefix;
}

/**
 * Complete the word at the end of `input` against `words` (SQL keywords plus
 * schema/table/column names). Case-insensitive prefix match:
 *  - one match  -> replace the token and append a trailing space (keywords are
 *    lowercased when the typed token is all lowercase);
 *  - many matches -> extend to the longest common prefix if that grows the
 *    token, otherwise return the sorted candidate list (capped at 40);
 *  - no match -> `none`. A dotted token (`schema.table`) that matches nothing
 *    as a whole is retried against the segment after the last dot.
 */
export function completeWord(input: string, words: string[]): CompleteResult {
  const m = input.match(/[A-Za-z0-9_".]+$/);
  if (!m) return { kind: 'none' };
  const token = m[0];

  const matchAgainst = (tok: string): string[] => {
    const lower = tok.toLowerCase();
    return words.filter((w) => w.toLowerCase().startsWith(lower));
  };

  let matchToken = token;
  let matches = matchAgainst(token);

  // Dotted token retry: complete the part after the last dot.
  if (matches.length === 0 && token.includes('.')) {
    const after = token.slice(token.lastIndexOf('.') + 1);
    if (after.length > 0) {
      const retried = matchAgainst(after);
      if (retried.length > 0) {
        matchToken = after;
        matches = retried;
      }
    }
  }

  if (matches.length === 0) return { kind: 'none' };

  const before = input.slice(0, input.length - matchToken.length);
  const tokenIsLower = matchToken === matchToken.toLowerCase();

  if (matches.length === 1) {
    let cand = matches[0];
    if (tokenIsLower && SQL_KEYWORD_SET.has(cand)) cand = cand.toLowerCase();
    return { kind: 'replace', newInput: `${before}${cand} ` };
  }

  const lcp = longestCommonPrefix(matches);
  if (lcp.length > matchToken.length) {
    let ext = lcp;
    if (tokenIsLower && matches.every((w) => SQL_KEYWORD_SET.has(w))) {
      ext = ext.toLowerCase();
    }
    return { kind: 'replace', newInput: `${before}${ext}` };
  }

  const list = [...matches].sort().slice(0, 40);
  return { kind: 'candidates', list };
}

/**
 * Copy `text` to the clipboard, returning whether it succeeded. Uses the async
 * Clipboard API when available (secure contexts) and falls back to a hidden
 * textarea + `execCommand('copy')` for plain-HTTP pages where `navigator.
 * clipboard` is undefined.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the execCommand fallback.
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** A rendered result table with hover copy buttons (CSV / TSV / JSON). */
function TableBlock({
  block,
}: {
  block: Extract<Block, { type: 'table' }>;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  const doCopy = async (fmt: 'CSV' | 'TSV' | 'JSON') => {
    const text =
      fmt === 'CSV'
        ? tableToCsv(block.columns, block.rows)
        : fmt === 'TSV'
        ? tableToTsv(block.columns, block.rows)
        : tableToJson(block.columns, block.rows);
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopyFailed(false);
      setCopied(fmt);
      setTimeout(() => setCopied(null), 1500);
    } else {
      setCopied(null);
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 1500);
    }
  };

  return (
    <div className="my-1">
      <div className="flex items-center justify-end gap-2 pb-0.5">
        {copied && (
          <span className="text-xs text-emerald-400">Copied!</span>
        )}
        {copyFailed && (
          <span className="text-xs text-red-400">Copy failed</span>
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // True while a (possibly multi-line) input is being processed, so a second
  // Enter cannot interleave with it between statements.
  const processingRef = useRef(false);
  const wordsRef = useRef<string[]>(SQL_KEYWORDS);

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

  // Load tab-completion words (schema/table/column names + keywords) once per
  // session and whenever the connected database changes. Failure degrades to
  // keywords only.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = db
          ? `/api/dumps/${dumpId}/schema?database=${encodeURIComponent(db)}`
          : `/api/dumps/${dumpId}/schema`;
        const res = await fetch(url);
        if (!res.ok) {
          if (!cancelled) wordsRef.current = SQL_KEYWORDS;
          return;
        }
        const data = (await res.json()) as {
          schema_graph?: {
            tables?: Array<{
              schema_name?: string;
              table_name?: string;
              columns?: Array<{ name?: string }>;
            }>;
          };
        } | null;
        if (cancelled) return;
        const set = new Set<string>(SQL_KEYWORDS);
        for (const t of data?.schema_graph?.tables ?? []) {
          if (t.schema_name) set.add(t.schema_name);
          if (t.table_name) set.add(t.table_name);
          for (const c of t.columns ?? []) if (c.name) set.add(c.name);
        }
        wordsRef.current = Array.from(set);
      } catch {
        if (!cancelled) wordsRef.current = SQL_KEYWORDS;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dumpId, db]);

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

  // Run the input editor's contents. Multi-line text (pasted, typed with
  // Shift+Enter, or recalled from history) is processed line by line exactly
  // as if each line had been typed and entered in psql; statements completed
  // along the way are executed in order.
  const handleEnter = async () => {
    if (running || processingRef.current) return;
    processingRef.current = true;
    const lines = input.replace(/\r\n?/g, '\n').split('\n');
    setInput('');
    setHistoryIndex(-1);
    try {
      let buf = buffer;
      for (const line of lines) {
        appendEntries([{ kind: 'input', prompt: promptFor(buf.length > 0), text: line }]);
        const r = processLine(buf, line);
        buf = r.buffer;
        setBuffer(buf);
        if (r.submit !== null) await submit(r.submit);
      }
    } finally {
      processingRef.current = false;
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

  const applyCompletion = () => {
    const result = completeWord(input, wordsRef.current);
    if (result.kind === 'replace') {
      setInput(result.newInput);
    } else if (result.kind === 'candidates') {
      appendBlocks([{ type: 'text', text: result.list.join('  ') }]);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      // Enter runs; Shift+Enter inserts a newline (IME composition is left alone).
      e.preventDefault();
      void handleEnter();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      // Tab: simple completion. Shift+Tab keeps the browser default (leave the
      // terminal via keyboard).
      e.preventDefault();
      applyCompletion();
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      handleCtrlC();
    } else if (e.key === 'ArrowUp' && !el.value.slice(0, el.selectionStart).includes('\n')) {
      // History only from the first line; otherwise move the caret normally.
      e.preventDefault();
      navHistory(1);
    } else if (e.key === 'ArrowDown' && !el.value.slice(el.selectionEnd).includes('\n')) {
      e.preventDefault();
      navHistory(-1);
    }
  };

  return (
    <div className="space-y-2">
      {/* Thin amber note. */}
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
        Runs against a disposable sandbox. \? for help, statements end with ; (Shift+Enter for a new line)
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
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={running}
            rows={Math.min(Math.max(input.split('\n').length, 1), 15)}
            className="flex-1 resize-none overflow-y-auto whitespace-pre border-none bg-transparent p-0 font-mono text-slate-100 outline-none"
            autoFocus
            spellCheck={false}
            aria-label="Terminal input"
          />
        </div>
      </div>
    </div>
  );
}
