'use client';

interface DataTableProps {
  columns: string[];
  rows: Record<string, unknown>[];
  onCellClick?: (column: string, value: unknown, row: Record<string, unknown>) => void;
}

export function DataTable({ columns, rows, onCellClick }: DataTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIdx) => (
            <tr key={rowIdx}>
              {columns.map((col) => (
                <td
                  key={col}
                  onClick={() => onCellClick?.(col, row[col], row)}
                  className="hover:bg-blue-50 dark:hover:bg-blue-900/30"
                >
                  {formatCellValue(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
