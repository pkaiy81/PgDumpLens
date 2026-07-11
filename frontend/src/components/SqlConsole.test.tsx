import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SqlConsole } from './SqlConsole';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function typeAndRun(sql: string) {
  const textarea = screen.getByPlaceholderText(/SELECT \* FROM/i);
  fireEvent.change(textarea, { target: { value: sql } });
  fireEvent.click(screen.getByRole('button', { name: /run/i }));
}

describe('SqlConsole', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    localStorage.clear();
  });

  it('renders a row result set with columns and cells', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        kind: 'rows',
        columns: ['id', 'name'],
        rows: [{ id: 1, name: 'Alice' }],
        row_count: 1,
        truncated: false,
        rows_affected: null,
        execution_ms: 12,
      }),
    });

    render(<SqlConsole dumpId="123" />);
    typeAndRun('SELECT * FROM users');

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });
    expect(screen.getByText('id')).toBeInTheDocument();
    expect(screen.getByText('name')).toBeInTheDocument();
    expect(screen.getByText('12 ms')).toBeInTheDocument();

    // Request body carries the SQL.
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.sql).toBe('SELECT * FROM users');
  });

  it('shows the truncated banner when the result is truncated', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        kind: 'rows',
        columns: ['id'],
        rows: [{ id: 1 }],
        row_count: 1,
        truncated: true,
        rows_affected: null,
        execution_ms: 5,
      }),
    });

    render(<SqlConsole dumpId="123" />);
    typeAndRun('SELECT * FROM big');

    await waitFor(() => {
      expect(screen.getByText(/truncated/i)).toBeInTheDocument();
    });
  });

  it('renders a command result with rows affected', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        kind: 'command',
        columns: [],
        rows: [],
        row_count: 0,
        truncated: false,
        rows_affected: 3,
        execution_ms: 8,
      }),
    });

    render(<SqlConsole dumpId="123" />);
    typeAndRun('UPDATE users SET x = 1');

    await waitFor(() => {
      expect(screen.getByText(/3 row\(s\) affected \(8 ms\)/)).toBeInTheDocument();
    });
  });

  it('shows the server error message on failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: 'SQL error: division by zero' }),
    });

    render(<SqlConsole dumpId="123" />);
    typeAndRun('SELECT 1/0');

    await waitFor(() => {
      expect(screen.getByText('SQL error: division by zero')).toBeInTheDocument();
    });
  });

  it('records successful queries in history', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        kind: 'rows',
        columns: ['id'],
        rows: [{ id: 1 }],
        row_count: 1,
        truncated: false,
        rows_affected: null,
        execution_ms: 2,
      }),
    });

    render(<SqlConsole dumpId="123" />);
    typeAndRun('SELECT 1');

    await waitFor(() => {
      expect(screen.getByText(/Show history/i)).toBeInTheDocument();
    });
    const stored = JSON.parse(
      localStorage.getItem('pgdumplens:sql-history:123') || '[]'
    );
    expect(stored[0].sql).toBe('SELECT 1');
  });
});
