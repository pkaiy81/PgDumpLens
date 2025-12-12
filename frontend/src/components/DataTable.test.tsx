import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataTable } from './DataTable';

describe('DataTable', () => {
  it('renders column headers', () => {
    const columns = ['id', 'name', 'email'];
    const rows: Record<string, unknown>[] = [];

    render(<DataTable columns={columns} rows={rows} />);

    expect(screen.getByText('id')).toBeInTheDocument();
    expect(screen.getByText('name')).toBeInTheDocument();
    expect(screen.getByText('email')).toBeInTheDocument();
  });

  it('renders row data', () => {
    const columns = ['id', 'name'];
    const rows = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ];

    render(<DataTable columns={columns} rows={rows} />);

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('renders NULL for null values', () => {
    const columns = ['id', 'name'];
    const rows = [{ id: 1, name: null }];

    render(<DataTable columns={columns} rows={rows} />);

    expect(screen.getByText('NULL')).toBeInTheDocument();
  });

  it('renders JSON for object values', () => {
    const columns = ['id', 'metadata'];
    const rows = [{ id: 1, metadata: { key: 'value' } }];

    render(<DataTable columns={columns} rows={rows} />);

    expect(screen.getByText('{"key":"value"}')).toBeInTheDocument();
  });

  it('calls onCellClick when cell is clicked', async () => {
    const columns = ['id', 'name'];
    const rows = [{ id: 1, name: 'Alice' }];
    const onCellClick = vi.fn();

    render(<DataTable columns={columns} rows={rows} onCellClick={onCellClick} />);

    const cell = screen.getByText('Alice');
    cell.click();

    expect(onCellClick).toHaveBeenCalledWith('name', 'Alice', { id: 1, name: 'Alice' });
  });
});
