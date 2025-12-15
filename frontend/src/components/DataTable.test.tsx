import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
