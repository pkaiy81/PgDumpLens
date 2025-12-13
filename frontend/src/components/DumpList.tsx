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
      <div className="p-6 space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="animate-pulse flex items-center justify-between p-4 bg-slate-100 dark:bg-slate-700/50 rounded-xl">
            <div className="space-y-2">
              <div className="h-4 w-48 bg-slate-200 dark:bg-slate-600 rounded"></div>
              <div className="h-3 w-24 bg-slate-200 dark:bg-slate-600 rounded"></div>
            </div>
            <div className="h-6 w-16 bg-slate-200 dark:bg-slate-600 rounded-full"></div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-6 p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-xl border border-red-200 dark:border-red-800 flex items-center">
        <svg className="w-5 h-5 mr-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        Failed to load dumps. Please try again.
      </div>
    );
  }

  if (!dumps || dumps.length === 0) {
    return (
      <div className="text-center py-12 px-6">
        <div className="w-16 h-16 mx-auto mb-4 bg-slate-100 dark:bg-slate-800 rounded-2xl flex items-center justify-center">
          <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
          </svg>
        </div>
        <p className="text-slate-500 dark:text-slate-400 mb-4">No dumps yet</p>
        <Link href="/upload" className="text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 font-medium">
          Upload your first dump →
        </Link>
      </div>
    );
  }

  return (
    <div className="divide-y divide-slate-200 dark:divide-slate-700">
      {dumps.map((dump) => (
        <Link
          key={dump.id}
          href={`/d/${dump.slug}`}
          className="flex items-center justify-between p-5 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
        >
          <div className="flex items-center space-x-4">
            <div className="w-10 h-10 bg-gradient-to-br from-indigo-100 to-purple-100 dark:from-indigo-900/50 dark:to-purple-900/50 rounded-xl flex items-center justify-center">
              <svg className="w-5 h-5 text-indigo-600 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
              </svg>
            </div>
            <div>
              <h4 className="font-medium text-slate-900 dark:text-white">
                {dump.name || dump.slug}
              </h4>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {dump.file_size
                  ? `${(dump.file_size / 1024 / 1024).toFixed(2)} MB`
                  : 'Size unknown'}
                <span className="mx-2">•</span>
                {formatDistanceToNow(new Date(dump.created_at))}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <StatusBadge status={dump.status} />
            <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </Link>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const statusConfig: Record<string, { bg: string; text: string; dot: string }> = {
    CREATED: { bg: 'bg-slate-100 dark:bg-slate-700', text: 'text-slate-600 dark:text-slate-300', dot: 'bg-slate-400' },
    UPLOADING: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-300', dot: 'bg-blue-500' },
    UPLOADED: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-300', dot: 'bg-blue-500' },
    RESTORING: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
    ANALYZING: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
    READY: { bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500' },
    ERROR: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-300', dot: 'bg-red-500' },
    DELETED: { bg: 'bg-slate-100 dark:bg-slate-700', text: 'text-slate-600 dark:text-slate-300', dot: 'bg-slate-400' },
  };

  const config = statusConfig[status] || statusConfig.CREATED;

  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${config.bg} ${config.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full mr-2 ${config.dot}`}></span>
      {status}
    </span>
  );
}
