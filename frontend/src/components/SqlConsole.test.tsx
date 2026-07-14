import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import {
  SqlConsole,
  tableToCsv,
  tableToTsv,
  tableToJson,
  completeWord,
  copyTextToClipboard,
  SQL_KEYWORDS,
} from './SqlConsole';

const mockFetch = vi.fn();
global.fetch = mockFetch;

// Console (session-create / execute / DELETE) responses are dispensed in FIFO
// order from this queue; schema requests are answered out-of-band from
// `schemaBody` so tab-completion fetches never disturb the ordered mocks.
const consoleQueue: unknown[] = [];
let schemaBody: unknown = {};

function enqueue(...responses: unknown[]) {
  consoleQueue.push(...responses);
}

// A successful session-creation response.
function sessionResponse(database = 'mydb') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      session_id: 's-1',
      database,
      prompt: `${database}=#`,
    }),
  };
}

// A successful execute response carrying the given blocks.
function executeResponse(
  blocks: unknown[],
  overrides: Record<string, unknown> = {}
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      blocks,
      database: 'mydb',
      prompt: 'mydb=#',
      expanded: false,
      timing: false,
      session_ended: false,
      execution_ms: 12,
      ...overrides,
    }),
  };
}

function tableBlock() {
  return {
    type: 'table',
    columns: ['id', 'name'],
    rows: [['1', 'Alice']],
    footer: '(1 row)',
    expanded: false,
  };
}

function terminalInput() {
  return screen.getByLabelText('Terminal input') as HTMLInputElement;
}

function enter(value: string) {
  const el = terminalInput();
  fireEvent.change(el, { target: { value } });
  fireEvent.keyDown(el, { key: 'Enter' });
}

// Console POSTs to /api/console/:id (execute), excluding the DELETE teardown.
function executePosts() {
  return mockFetch.mock.calls.filter(
    (c) =>
      typeof c[0] === 'string' &&
      c[0].startsWith('/api/console/') &&
      c[1]?.method === 'POST'
  );
}

// Session-creation POSTs to /api/dumps/:id/console.
function createPosts() {
  return mockFetch.mock.calls.filter((c) => c[0] === '/api/dumps/123/console');
}

describe('SqlConsole', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    consoleQueue.length = 0;
    schemaBody = {};
    // Reset clipboard between tests; individual tests opt into a mock.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    mockFetch.mockImplementation((url: unknown, opts?: { method?: string }) => {
      const u = String(url);
      if (u.includes('/schema')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => schemaBody,
        });
      }
      if (opts?.method === 'DELETE') {
        return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
      }
      if (consoleQueue.length) return Promise.resolve(consoleQueue.shift());
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    localStorage.clear();
  });

  it('creates a session on mount and shows the prompt', async () => {
    enqueue(sessionResponse());

    render(<SqlConsole dumpId="123" />);

    await waitFor(() => {
      expect(screen.getByText('mydb=#')).toBeInTheDocument();
    });
    const create = createPosts()[0];
    expect(create[0]).toBe('/api/dumps/123/console');
    expect(create[1].method).toBe('POST');
    expect(
      screen.getByText(/You are connected to database "mydb"\./)
    ).toBeInTheDocument();
  });

  it('runs a semicolon-terminated statement and renders a table', async () => {
    enqueue(sessionResponse(), executeResponse([tableBlock()]));

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('SELECT 1;');

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });
    expect(screen.getByText('(1 row)')).toBeInTheDocument();

    const execCall = executePosts()[0];
    expect(execCall[0]).toBe('/api/console/s-1');
    expect(JSON.parse(execCall[1].body).input).toBe('SELECT 1;');
  });

  it('buffers a multi-line statement until the terminating semicolon', async () => {
    enqueue(sessionResponse(), executeResponse([{ type: 'text', text: 'SELECT 1' }]));

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('SELECT *');
    // Continuation prompt appears; no execute call yet.
    await waitFor(() => expect(screen.getByText('mydb-#')).toBeInTheDocument());
    expect(executePosts()).toHaveLength(0);

    enter('FROM t;');

    await waitFor(() => expect(executePosts()).toHaveLength(1));
    const body = JSON.parse(executePosts()[0][1].body);
    expect(body.input).toBe('SELECT *\nFROM t;');
  });

  it('does nothing on an empty line with an empty buffer', async () => {
    enqueue(sessionResponse());

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('');

    // Prompt is echoed but we stay at the primary prompt (no continuation) and
    // nothing is sent to the backend.
    expect(screen.queryByText('mydb-#')).not.toBeInTheDocument();
    expect(executePosts()).toHaveLength(0);
  });

  it('runs a meta-command immediately even mid-continuation, keeping the buffer', async () => {
    enqueue(
      sessionResponse(),
      executeResponse([
        {
          type: 'table',
          columns: ['Schema', 'Name', 'Type', 'Owner'],
          rows: [['public', 'products', 'table', 'app']],
          footer: '(1 row)',
          expanded: false,
        },
      ]),
      executeResponse([{ type: 'text', text: 'done' }])
    );

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    // Enter a continuation (no semicolon).
    enter('SELECT 1');
    await waitFor(() => expect(screen.getByText('mydb-#')).toBeInTheDocument());

    // A meta-command executes at once and leaves us in continuation.
    enter('\\dt');
    await waitFor(() => expect(executePosts()).toHaveLength(1));
    expect(JSON.parse(executePosts()[0][1].body).input).toBe('\\dt');
    // Still in continuation (the buffer was preserved).
    expect(screen.getAllByText('mydb-#').length).toBeGreaterThan(0);

    // The buffered statement is still there and completes on the semicolon.
    enter('+ 1;');
    await waitFor(() => expect(executePosts()).toHaveLength(2));
    expect(JSON.parse(executePosts()[1][1].body).input).toBe('SELECT 1\n+ 1;');
  });

  it('sends a meta-command immediately without a semicolon', async () => {
    enqueue(
      sessionResponse(),
      executeResponse([
        {
          type: 'table',
          columns: ['Schema', 'Name', 'Type', 'Owner'],
          rows: [['public', 'products', 'table', 'app']],
          footer: '(1 row)',
          expanded: false,
        },
      ])
    );

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('\\dt');

    await waitFor(() => expect(executePosts()).toHaveLength(1));
    expect(JSON.parse(executePosts()[0][1].body).input).toBe('\\dt');
    expect(screen.getByText('products')).toBeInTheDocument();
  });

  it('updates the prompt and shows a notice after \\c', async () => {
    enqueue(
      sessionResponse(),
      executeResponse(
        [
          {
            type: 'notice',
            text: 'You are now connected to database "hrdb".',
          },
        ],
        { database: 'hrdb', prompt: 'hrdb=#' }
      )
    );

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('\\c hrdb');

    await waitFor(() => expect(screen.getByText('hrdb=#')).toBeInTheDocument());
    expect(
      screen.getByText('You are now connected to database "hrdb".')
    ).toBeInTheDocument();
  });

  it('renders an error block in red', async () => {
    enqueue(
      sessionResponse(),
      executeResponse([{ type: 'error', text: 'ERROR:  division by zero' }])
    );

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('SELECT 1/0;');

    await waitFor(() => {
      const el = screen.getByText(/ERROR:\s+division by zero/);
      expect(el).toBeInTheDocument();
      expect(el.className).toContain('text-red-400');
    });
  });

  it('restores the previous command with ArrowUp and persists history', async () => {
    enqueue(sessionResponse(), executeResponse([tableBlock()]));

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('SELECT 1;');
    await waitFor(() => expect(executePosts()).toHaveLength(1));

    const el = terminalInput();
    fireEvent.keyDown(el, { key: 'ArrowUp' });
    expect(el.value).toBe('SELECT 1;');

    const stored = JSON.parse(
      localStorage.getItem('pgdumplens:sql-history:123') || '[]'
    );
    expect(stored[0].sql).toBe('SELECT 1;');
  });

  it('recreates the session and retries on a 404', async () => {
    enqueue(
      sessionResponse(), // initial session
      { ok: false, status: 404, json: async () => ({}) }, // execute -> expired
      sessionResponse(), // recreate
      executeResponse([tableBlock()]) // retry succeeds
    );

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('SELECT 1;');

    await waitFor(() => {
      expect(
        screen.getByText('Session expired — reconnected.')
      ).toBeInTheDocument();
    });
    expect(screen.getByText('Alice')).toBeInTheDocument();
    // Session created twice (initial + recreate) and executed twice.
    expect(createPosts()).toHaveLength(2);
    expect(executePosts()).toHaveLength(2);
  });

  it('refocuses the terminal input after a command completes', async () => {
    enqueue(sessionResponse(), executeResponse([tableBlock()]));

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('SELECT 1;');
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    await waitFor(() => {
      expect(document.activeElement).toBe(terminalInput());
    });
  });

  it('does not steal focus while text is selected', async () => {
    enqueue(sessionResponse());

    const { container } = render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    const panel = container.querySelector(
      '[class*="overflow-y-auto"]'
    ) as HTMLElement;
    const input = terminalInput();
    input.blur();
    expect(document.activeElement).not.toBe(input);

    const sel = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ toString: () => 'selected text' } as unknown as Selection);

    // With a live selection, clicking the panel must not refocus the input.
    fireEvent.click(panel);
    expect(document.activeElement).not.toBe(input);

    // With no selection, clicking focuses the input as before.
    sel.mockReturnValue({ toString: () => '' } as unknown as Selection);
    fireEvent.click(panel);
    expect(document.activeElement).toBe(input);

    sel.mockRestore();
  });

  it('completes a keyword with Tab', async () => {
    enqueue(sessionResponse());

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    const el = terminalInput();
    fireEvent.change(el, { target: { value: 'SEL' } });
    const evt = fireEvent.keyDown(el, { key: 'Tab' });
    // preventDefault ran (dispatchEvent returns false when canceled).
    expect(evt).toBe(false);
    expect(el.value).toBe('SELECT ');
  });

  it('copies a result table as CSV and JSON', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: { writeText },
    });

    enqueue(
      sessionResponse(),
      executeResponse([
        {
          type: 'table',
          columns: ['id', 'name'],
          rows: [
            ['1', 'Alice'],
            ['2', null],
          ],
          footer: '(2 rows)',
          expanded: false,
        },
      ])
    );

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('SELECT * FROM users;');
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Copy CSV'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText).toHaveBeenLastCalledWith('id,name\n1,Alice\n2,');

    fireEvent.click(screen.getByText('Copy JSON'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(JSON.parse(writeText.mock.calls[1][0])).toEqual([
      { id: '1', name: 'Alice' },
      { id: '2', name: null },
    ]);
  });

  it('falls back to execCommand when the clipboard API is unavailable', async () => {
    // navigator.clipboard is undefined (reset in beforeEach) — plain-HTTP page.
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;

    enqueue(sessionResponse(), executeResponse([tableBlock()]));

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('SELECT 1;');
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Copy CSV'));

    await waitFor(() => expect(exec).toHaveBeenCalledWith('copy'));
    expect(await screen.findByText('Copied!')).toBeInTheDocument();
  });

  it('shows "Copy failed" when copying fails entirely', async () => {
    const exec = vi.fn().mockReturnValue(false);
    document.execCommand = exec;

    enqueue(sessionResponse(), executeResponse([tableBlock()]));

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('SELECT 1;');
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Copy CSV'));

    expect(await screen.findByText('Copy failed')).toBeInTheDocument();
  });
});

describe('completeWord', () => {
  it('replaces a single keyword match and appends a space', () => {
    expect(completeWord('SEL', SQL_KEYWORDS)).toEqual({
      kind: 'replace',
      newInput: 'SELECT ',
    });
  });

  it('lowercases the keyword when the typed token is lowercase', () => {
    expect(completeWord('sel', SQL_KEYWORDS)).toEqual({
      kind: 'replace',
      newInput: 'select ',
    });
  });

  it('completes a table name preserving its casing', () => {
    const words = [...SQL_KEYWORDS, 'products'];
    expect(completeWord('SELECT * FROM pro', words)).toEqual({
      kind: 'replace',
      newInput: 'SELECT * FROM products ',
    });
  });

  it('extends to the longest common prefix on multiple matches', () => {
    const words = ['order_items', 'order_coupons'];
    expect(completeWord('ord', words)).toEqual({
      kind: 'replace',
      newInput: 'order_',
    });
  });

  it('returns a sorted candidate list when it cannot extend', () => {
    const words = ['orders', 'order_items', 'order_coupons'];
    expect(completeWord('order', words)).toEqual({
      kind: 'candidates',
      list: ['order_coupons', 'order_items', 'orders'],
    });
  });

  it('returns none when nothing matches', () => {
    expect(completeWord('SELECT zzz', SQL_KEYWORDS)).toEqual({ kind: 'none' });
  });

  it('returns none when there is no word at the end', () => {
    expect(completeWord('SELECT 1 ', SQL_KEYWORDS)).toEqual({ kind: 'none' });
  });

  it('retries after the dot for a dotted token', () => {
    expect(completeWord('public.pro', ['products'])).toEqual({
      kind: 'replace',
      newInput: 'public.products ',
    });
  });
});

describe('copyTextToClipboard', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  it('uses the async clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: { writeText },
    });
    const ok = await copyTextToClipboard('hello');
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand in non-secure contexts', async () => {
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;
    const ok = await copyTextToClipboard('hello');
    expect(ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('returns false when execCommand reports failure', async () => {
    document.execCommand = vi.fn().mockReturnValue(false);
    expect(await copyTextToClipboard('hello')).toBe(false);
  });
});

describe('table serializers', () => {
  const columns = ['id', 'note'];
  const rows: (string | null)[][] = [
    ['1', 'a,b'],
    ['2', null],
    ['3', 'has "quote"'],
  ];

  it('tableToCsv quotes special chars and empties NULL', () => {
    expect(tableToCsv(columns, rows)).toBe(
      'id,note\n1,"a,b"\n2,\n3,"has ""quote"""'
    );
  });

  it('tableToTsv is tab-separated with empty NULL', () => {
    expect(tableToTsv(columns, rows)).toBe(
      'id\tnote\n1\ta,b\n2\t\n3\thas "quote"'
    );
  });

  it('tableToJson maps NULL to null', () => {
    expect(JSON.parse(tableToJson(columns, rows))).toEqual([
      { id: '1', note: 'a,b' },
      { id: '2', note: null },
      { id: '3', note: 'has "quote"' },
    ]);
  });
});
