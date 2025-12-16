'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { DataTable } from '@/components/DataTable';
import { MermaidDiagram } from '@/components/MermaidDiagram';
import { RiskBadge } from '@/components/RiskBadge';

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
}

interface ForeignKey {
  constraint_name: string;
  column_name: string;
  foreign_table_schema: string;
  foreign_table_name: string;
  foreign_column_name: string;
}

interface Table {
  schema: string;
  name: string;
  columns: Column[];
  foreign_keys: ForeignKey[];
  row_count: number | null;
}

interface SchemaGraph {
  tables: Table[];
  foreign_keys: any[];
}

interface SchemaResponse {
  schema_graph: SchemaGraph;
  mermaid_er: string;
}

export default function DumpDetailPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [dump, setDump] = useState<Dump | null>(null);
  const [schema, setSchema] = useState<SchemaResponse | null>(null);
  const [selectedTable, setSelectedTable] = useState<Table | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'schema' | 'data' | 'erd'>('erd');

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
      if (data.schema_graph.tables.length > 0) {
        setSelectedTable(data.schema_graph.tables[0]);
      }
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
          // Poll for status updates
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

  const formatBytes = (bytes: number | null) => {
    if (bytes === null) return 'Unknown';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString();
  };

  if (error) {
    return (
      <div className="max-w-4xl mx-auto py-8">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl p-8 text-center">
          <svg className="w-16 h-16 mx-auto text-red-500 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <h2 className="text-xl font-semibold text-red-700 dark:text-red-300 mb-2">Error</h2>
          <p className="text-red-600 dark:text-red-400 mb-4">{error}</p>
          <Link href="/" className="inline-flex items-center text-indigo-600 dark:text-indigo-400 hover:underline">
            ← Back to Home
          </Link>
        </div>
      </div>
    );
  }

  if (loading || !dump) {
    return (
      <div className="max-w-4xl mx-auto py-8">
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-8 text-center">
          <div className="animate-spin w-16 h-16 mx-auto border-4 border-indigo-200 border-t-indigo-600 rounded-full mb-4"></div>
          <h2 className="text-xl font-semibold text-slate-700 dark:text-slate-300 mb-2">
            {dump?.status === 'RESTORING' ? 'Restoring Database...' : 'Loading...'}
          </h2>
          <p className="text-slate-500 dark:text-slate-400">
            {dump?.status === 'RESTORING' 
              ? 'This may take a few moments for large dumps.' 
              : 'Please wait while we load your dump.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Link href="/" className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
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
            <span>Size: {formatBytes(dump.file_size)}</span>
            <span>•</span>
            <span>Created: {formatDate(dump.created_at)}</span>
            <span>•</span>
            <span>Expires: {formatDate(dump.expires_at)}</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-200 dark:border-slate-700">
        <nav className="flex gap-4">
          {(['erd', 'schema', 'data'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`py-3 px-4 font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                  : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
            >
              {tab === 'erd' ? 'ER Diagram' : tab === 'schema' ? 'Schema' : 'Data Explorer'}
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      {activeTab === 'erd' && schema && (
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">Entity Relationship Diagram</h2>
          <div className="overflow-auto">
            <MermaidDiagram chart={schema.mermaid_er} />
          </div>
        </div>
      )}

      {activeTab === 'schema' && schema && (
        <div className="grid md:grid-cols-4 gap-6">
          {/* Table List */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">
              Tables ({schema.schema_graph.tables.length})
            </h3>
            <div className="space-y-1 max-h-[600px] overflow-y-auto">
              {schema.schema_graph.tables.map((table) => (
                <button
                  key={`${table.schema}.${table.name}`}
                  onClick={() => setSelectedTable(table)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                    selectedTable?.name === table.name && selectedTable?.schema === table.schema
                      ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                  }`}
                >
                  <span className="text-slate-400 dark:text-slate-500">{table.schema}.</span>
                  {table.name}
                  {table.row_count !== null && (
                    <span className="ml-2 text-xs text-slate-400">({table.row_count})</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Table Details */}
          <div className="md:col-span-3 bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
            {selectedTable ? (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                    {selectedTable.schema}.{selectedTable.name}
                  </h3>
                  <RiskBadge 
                    dumpId={dump.id} 
                    schema={selectedTable.schema} 
                    table={selectedTable.name} 
                  />
                </div>

                <h4 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Columns</h4>
                <div className="overflow-x-auto mb-6">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-700">
                        <th className="text-left py-2 px-3 text-slate-500 dark:text-slate-400 font-medium">Name</th>
                        <th className="text-left py-2 px-3 text-slate-500 dark:text-slate-400 font-medium">Type</th>
                        <th className="text-left py-2 px-3 text-slate-500 dark:text-slate-400 font-medium">Nullable</th>
                        <th className="text-left py-2 px-3 text-slate-500 dark:text-slate-400 font-medium">PK</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedTable.columns.map((col) => (
                        <tr key={col.name} className="border-b border-slate-100 dark:border-slate-700/50">
                          <td className="py-2 px-3 text-slate-900 dark:text-white font-mono">{col.name}</td>
                          <td className="py-2 px-3 text-slate-600 dark:text-slate-400 font-mono">{col.data_type}</td>
                          <td className="py-2 px-3">
                            {col.is_nullable ? (
                              <span className="text-slate-400">Yes</span>
                            ) : (
                              <span className="text-slate-900 dark:text-white">No</span>
                            )}
                          </td>
                          <td className="py-2 px-3">
                            {col.is_primary_key && (
                              <span className="px-2 py-0.5 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 rounded text-xs">PK</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {selectedTable.foreign_keys && selectedTable.foreign_keys.length > 0 && (
                  <>
                    <h4 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Foreign Keys</h4>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 dark:border-slate-700">
                            <th className="text-left py-2 px-3 text-slate-500 dark:text-slate-400 font-medium">Column</th>
                            <th className="text-left py-2 px-3 text-slate-500 dark:text-slate-400 font-medium">References</th>
                            <th className="text-left py-2 px-3 text-slate-500 dark:text-slate-400 font-medium">Constraint</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedTable.foreign_keys.map((fk) => (
                            <tr key={fk.constraint_name} className="border-b border-slate-100 dark:border-slate-700/50">
                              <td className="py-2 px-3 text-slate-900 dark:text-white font-mono">{fk.column_name}</td>
                              <td className="py-2 px-3 text-indigo-600 dark:text-indigo-400 font-mono">
                                {fk.foreign_table_schema}.{fk.foreign_table_name}.{fk.foreign_column_name}
                              </td>
                              <td className="py-2 px-3 text-slate-500 dark:text-slate-400 font-mono text-xs">{fk.constraint_name}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </>
            ) : (
              <p className="text-slate-500 dark:text-slate-400">Select a table to view details</p>
            )}
          </div>
        </div>
      )}

      {activeTab === 'data' && schema && selectedTable && (
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <select
                value={`${selectedTable.schema}.${selectedTable.name}`}
                onChange={(e) => {
                  const [schemaName, tableName] = e.target.value.split('.');
                  const found = schema.schema_graph.tables.find((t) => t.schema === schemaName && t.name === tableName);
                  if (found) setSelectedTable(found);
                }}
                className="px-3 py-2 bg-slate-100 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-slate-900 dark:text-white"
              >
                {schema.schema_graph.tables.map((table) => (
                  <option key={`${table.schema}.${table.name}`} value={`${table.schema}.${table.name}`}>
                    {table.schema}.{table.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DataTable dumpId={dump.id} schema={selectedTable.schema} table={selectedTable.name} />
        </div>
      )}
    </div>
  );
}
