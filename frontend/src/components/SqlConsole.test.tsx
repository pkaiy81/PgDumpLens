import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import {
  SqlConsole,
  tableToCsv,
  tableToTsv,
  tableToJson,
} from './SqlConsole';

const mockFetch = vi.fn();
global.fetch = mockFetch;

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

describe('SqlConsole', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Default response so unmount DELETE / unexpected calls resolve cleanly.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    localStorage.clear();
  });

  it('creates a session on mount and shows the prompt', async () => {
    mockFetch.mockResolvedValueOnce(sessionResponse());

    render(<SqlConsole dumpId="123" />);

    await waitFor(() => {
      expect(screen.getByText('mydb=#')).toBeInTheDocument();
    });
    // The first call is the session-creation POST.
    expect(mockFetch.mock.calls[0][0]).toBe('/api/dumps/123/console');
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    expect(
      screen.getByText(/You are connected to database "mydb"\./)
    ).toBeInTheDocument();
  });

  it('runs a semicolon-terminated statement and renders a table', async () => {
    mockFetch
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(executeResponse([tableBlock()]));

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('SELECT 1;');

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });
    expect(screen.getByText('(1 row)')).toBeInTheDocument();

    // The execute call carries the raw input.
    const execCall = mockFetch.mock.calls[1];
    expect(execCall[0]).toBe('/api/console/s-1');
    expect(JSON.parse(execCall[1].body).input).toBe('SELECT 1;');
  });

  it('buffers a multi-line statement until the terminating semicolon', async () => {
    mockFetch
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(executeResponse([{ type: 'text', text: 'SELECT 1' }]));

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('SELECT *');
    // Continuation prompt appears; no execute call yet.
    await waitFor(() => expect(screen.getByText('mydb-#')).toBeInTheDocument());
    expect(mockFetch).toHaveBeenCalledTimes(1);

    enter('FROM t;');

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.input).toBe('SELECT *\nFROM t;');
  });

  it('sends a meta-command immediately without a semicolon', async () => {
    mockFetch
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
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

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.input).toBe('\\dt');
    expect(screen.getByText('products')).toBeInTheDocument();
  });

  it('updates the prompt and shows a notice after \\c', async () => {
    mockFetch
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
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
    mockFetch
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        executeResponse([
          { type: 'error', text: 'ERROR:  division by zero' },
        ])
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
    mockFetch
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(executeResponse([tableBlock()]));

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('SELECT 1;');
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    const el = terminalInput();
    fireEvent.keyDown(el, { key: 'ArrowUp' });
    expect(el.value).toBe('SELECT 1;');

    const stored = JSON.parse(
      localStorage.getItem('pgdumplens:sql-history:123') || '[]'
    );
    expect(stored[0].sql).toBe('SELECT 1;');
  });

  it('recreates the session and retries on a 404', async () => {
    mockFetch
      .mockResolvedValueOnce(sessionResponse()) // initial session
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }) // execute -> expired
      .mockResolvedValueOnce(sessionResponse()) // recreate
      .mockResolvedValueOnce(executeResponse([tableBlock()])); // retry succeeds

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('SELECT 1;');

    await waitFor(() => {
      expect(
        screen.getByText('Session expired — reconnected.')
      ).toBeInTheDocument();
    });
    expect(screen.getByText('Alice')).toBeInTheDocument();
    // create + execute(404) + recreate + retry = 4 calls.
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('refocuses the terminal input after a command completes', async () => {
    mockFetch
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(executeResponse([tableBlock()]));

    render(<SqlConsole dumpId="123" />);
    await waitFor(() => expect(screen.getByText('mydb=#')).toBeInTheDocument());

    enter('SELECT 1;');
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    await waitFor(() => {
      expect(document.activeElement).toBe(terminalInput());
    });
  });

  it('copies a result table as CSV and JSON', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    mockFetch
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
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
