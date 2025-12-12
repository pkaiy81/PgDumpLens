'use client';

import useSWR from 'swr';
import Link from 'next/link';
import { formatDistanceToNow } from '@/lib/utils';
import { DumpSummary } from '@/types';

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export function DumpList() {
  const { data: dumps, error, isLoading } = useSWR<DumpSummary[]>(
    '/api/dumps',
    fetcher
  );

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-20 bg-gray-200 rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-red-600 p-4 bg-red-50 rounded-lg">
        Failed to load dumps. Please try again.
      </div>
    );
  }

  if (!dumps || dumps.length === 0) {
    return (
      <div className="text-gray-500 text-center py-8">
        No dumps yet. Upload one to get started.
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {dumps.map((dump) => (
        <Link
          key={dump.id}
          href={`/d/${dump.slug}`}
          className="block p-4 bg-white dark:bg-gray-800 rounded-lg shadow hover:shadow-md transition"
        >
          <div className="flex justify-between items-start">
            <div>
              <h4 className="font-medium text-gray-900 dark:text-white">
                {dump.name || dump.slug}
              </h4>
              <p className="text-sm text-gray-500">
                {dump.file_size
                  ? `${(dump.file_size / 1024 / 1024).toFixed(2)} MB`
                  : 'Size unknown'}
              </p>
            </div>
            <div className="text-right">
              <StatusBadge status={dump.status} />
              <p className="text-xs text-gray-400 mt-1">
                {formatDistanceToNow(new Date(dump.created_at))}
              </p>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const statusClasses: Record<string, string> = {
    CREATED: 'bg-gray-100 text-gray-800',
    UPLOADING: 'bg-blue-100 text-blue-800',
    UPLOADED: 'bg-blue-100 text-blue-800',
    RESTORING: 'bg-yellow-100 text-yellow-800',
    ANALYZING: 'bg-yellow-100 text-yellow-800',
    READY: 'bg-green-100 text-green-800',
    ERROR: 'bg-red-100 text-red-800',
    DELETED: 'bg-gray-100 text-gray-800',
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${
        statusClasses[status] || 'bg-gray-100 text-gray-800'
      }`}
    >
      {status}
    </span>
  );
}
