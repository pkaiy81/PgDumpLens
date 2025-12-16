'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { SchemaExplorer } from '@/components/SchemaExplorer';

interface Dump {
  id: string;
  slug: string;
  name: string | null;
  status: string;
  file_size: number | null;
  created_at: string;
  expires_at: string;
  error_message: string | null;
}

interface Column {
  name: string;
  data_type: string;
  is_nullable: boolean;
  is_primary_key: boolean;
  default_value?: string;
}

interface ForeignKey {
  constraint_name: string;
  source_schema: string;
  source_table: string;
  source_columns: string[];
  target_schema: string;
  target_table: string;
  target_columns: string[];
}

interface Table {
  schema_name: string;
  table_name: string;
  columns: Column[];
  estimated_row_count: number | null;
}

interface SchemaGraph {
  tables: Table[];
  foreign_keys: ForeignKey[];
}

interface SchemaResponse {
  schema_graph: SchemaGraph;
  mermaid_er: string;
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

export default function DumpDetailPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [dump, setDump] = useState<Dump | null>(null);
  const [schema, setSchema] = useState<SchemaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDump = useCallback(async () => {
    try {
      const res = await fetch(`/api/dumps/by-slug/${slug}`);
      if (!res.ok) {
        throw new Error('Dump not found');
      }
      const data = await res.json();
      setDump(data);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dump');
      return null;
    }
  }, [slug]);

  const fetchSchema = useCallback(async (dumpId: string) => {
    try {
      const res = await fetch(`/api/dumps/${dumpId}/schema`);
      if (!res.ok) {
        throw new Error('Failed to load schema');
      }
      const data = await res.json();
      setSchema(data);
    } catch (err) {
      console.error('Schema fetch error:', err);
    }
  }, []);

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;

    const loadData = async () => {
      setLoading(true);
      const dumpData = await fetchDump();
      
      if (dumpData) {
        if (dumpData.status === 'READY') {
          await fetchSchema(dumpData.id);
          setLoading(false);
        } else if (dumpData.status === 'RESTORING' || dumpData.status === 'UPLOADED') {
          interval = setInterval(async () => {
            const updated = await fetchDump();
            if (updated && updated.status === 'READY') {
              await fetchSchema(updated.id);
              setLoading(false);
              if (interval) clearInterval(interval);
            } else if (updated && updated.status === 'ERROR') {
              setError(updated.error_message || 'Restore failed');
              setLoading(false);
              if (interval) clearInterval(interval);
            }
          }, 2000);
        } else if (dumpData.status === 'ERROR') {
          setError(dumpData.error_message || 'Restore failed');
          setLoading(false);
        } else {
          setLoading(false);
        }
      } else {
        setLoading(false);
      }
    };

    loadData();

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [fetchDump, fetchSchema]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto py-12">
        <div className="flex flex-col items-center justify-center py-20">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-500 mb-4"></div>
          <p className="text-slate-500 dark:text-slate-400">
            {dump?.status === 'RESTORING' ? 'Restoring database...' : 'Loading...'}
          </p>
          {dump?.status === 'RESTORING' && (
            <p className="text-sm text-slate-400 dark:text-slate-500 mt-2">
              This may take a few minutes for large dumps
            </p>
          )}
        </div>
      </div>
    );
  }

  if (error || !dump) {
    return (
      <div className="max-w-7xl mx-auto py-12">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl p-6 text-center">
          <p className="text-red-600 dark:text-red-400">{error || 'Dump not found'}</p>
          <Link href="/" className="mt-4 inline-block text-indigo-600 hover:underline">
            ← Back to Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto py-6 space-y-6">
      {/* Header */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <Link 
                href="/" 
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
              </Link>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
                {dump.name || 'Untitled Dump'}
              </h1>
              <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                dump.status === 'READY' 
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                  : dump.status === 'ERROR'
                  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                  : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
              }`}>
                {dump.status}
              </span>
            </div>
            <div className="flex items-center gap-4 text-sm text-slate-500 dark:text-slate-400">
              <span>📦 {formatBytes(dump.file_size)}</span>
              <span>•</span>
              <span>🕐 Created: {formatDate(dump.created_at)}</span>
              <span>•</span>
              <span>⏰ Expires: {formatDate(dump.expires_at)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Schema Explorer */}
      {dump.status === 'READY' && schema ? (
        <SchemaExplorer 
          dumpId={dump.id}
          schemaGraph={schema.schema_graph}
          fullMermaidER={schema.mermaid_er}
        />
      ) : dump.status === 'ERROR' ? (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl p-6">
          <h2 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-2">Restore Failed</h2>
          <p className="text-red-500 dark:text-red-400/80">{dump.error_message}</p>
        </div>
      ) : (
        <div className="bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-200 dark:border-slate-700 p-12 text-center">
          <p className="text-slate-500 dark:text-slate-400">
            Waiting for dump to be processed...
          </p>
        </div>
      )}
    </div>
  );
}
