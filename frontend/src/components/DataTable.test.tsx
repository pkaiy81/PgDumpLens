import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { DataTable } from './DataTable';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('DataTable', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('shows loading state initially', () => {
    mockFetch.mockImplementation(() => new Promise(() => {})); // Never resolves

    render(<DataTable dumpId="123" schema="public" table="users" />);

    // Should show loading spinner (checking for the loading div)
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('renders column headers after loading', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        columns: ['id', 'name', 'email'],
        rows: [{ id: 1, name: 'Test', email: 'test@example.com' }],
        total_count: 1,
      }),
    });

    render(<DataTable dumpId="123" schema="public" table="users" />);

    await waitFor(() => {
      expect(screen.getByText('id')).toBeInTheDocument();
    });
    expect(screen.getByText('name')).toBeInTheDocument();
    expect(screen.getByText('email')).toBeInTheDocument();
  });

  it('renders row data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        columns: ['id', 'name'],
        rows: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        total_count: 2,
      }),
    });

    render(<DataTable dumpId="123" schema="public" table="users" />);

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('renders NULL for null values', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        columns: ['id', 'name'],
        rows: [{ id: 1, name: null }],
        total_count: 1,
      }),
    });

    render(<DataTable dumpId="123" schema="public" table="users" />);

    await waitFor(() => {
      expect(screen.getByText('NULL')).toBeInTheDocument();
    });
  });

  it('renders JSON for object values', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        columns: ['id', 'metadata'],
        rows: [{ id: 1, metadata: { key: 'value' } }],
        total_count: 1,
      }),
    });

    render(<DataTable dumpId="123" schema="public" table="users" />);

    await waitFor(() => {
      expect(screen.getByText('{"key":"value"}')).toBeInTheDocument();
    });
  });

  it('shows error message on fetch failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
    });

    render(<DataTable dumpId="123" schema="public" table="users" />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load table data')).toBeInTheDocument();
    });
  });

  it('sends filter params on the second fetch and reflects filtered count in badge', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/suggest')) {
        return Promise.resolve({ ok: true, json: async () => ({ suggestions: [] }) });
      }
      if (typeof url === 'string' && url.includes('filter=')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            columns: ['id', 'name'],
            rows: [{ id: 1, name: 'Alice' }],
            total_count: 1,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          columns: ['id', 'name'],
          rows: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
          total_count: 2,
        }),
      });
    });

    render(<DataTable dumpId="123" schema="public" table="users" />);

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

    // Open the filter dropdown for the "name" column.
    fireEvent.click(screen.getByTitle('Filter by name'));

    // Type a value and apply it with Enter.
    const input = screen.getByPlaceholderText('Filter name...');
    fireEvent.change(input, { target: { value: 'Alice' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // A follow-up fetch must include the server-side filter parameters.
    await waitFor(() => {
      const filterCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('filter=')
      );
      expect(filterCall).toBeTruthy();
      expect(filterCall![0]).toContain('filter=Alice');
      expect(filterCall![0]).toContain('filter_column=name');
    });

    // The badge shows the server-provided filtered total_count.
    await waitFor(() => {
      expect(screen.getByText('(1 matches)')).toBeInTheDocument();
    });
  });

  it('shows no data message when table is empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        columns: ['id'],
        rows: [],
        total_count: 0,
      }),
    });

    render(<DataTable dumpId="123" schema="public" table="users" />);

    await waitFor(() => {
      expect(screen.getByText('No data available')).toBeInTheDocument();
    });
  });
});
