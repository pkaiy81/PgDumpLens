'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { SchemaExplorer } from '@/components/SchemaExplorer';
import SearchResults from '@/components/SearchResults';
import DiffViewer from '@/components/DiffViewer';
import { SchemaDiffResponse, TableDataDiffResponse } from '@/types';

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

interface DatabaseList {
  databases: string[];
  primary: string | null;
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
  const router = useRouter();
  const slug = params.slug as string;

  const [dump, setDump] = useState<Dump | null>(null);
  const [schema, setSchema] = useState<SchemaResponse | null>(null);
  const [databases, setDatabases] = useState<DatabaseList | null>(null);
  const [selectedDb, setSelectedDb] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState<'schema' | 'search' | 'compare'>('schema');
  
  // Diff comparison state
  const [compareDumpId, setCompareDumpId] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<SchemaDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [compareFile, setCompareFile] = useState<File | null>(null);
  const [compareUploading, setCompareUploading] = useState(false);

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

  const fetchDatabases = useCallback(async (dumpId: string) => {
    try {
      const res = await fetch(`/api/dumps/${dumpId}/databases`);
      if (!res.ok) {
        // Fall back to single database mode
        return null;
      }
      const data: DatabaseList = await res.json();
      setDatabases(data);
      return data;
    } catch (err) {
      console.error('Databases fetch error:', err);
      return null;
    }
  }, []);

  const fetchSchema = useCallback(async (dumpId: string, database?: string) => {
    try {
      setSchemaLoading(true);
      const url = database 
        ? `/api/dumps/${dumpId}/schema?database=${encodeURIComponent(database)}`
        : `/api/dumps/${dumpId}/schema`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error('Failed to load schema');
      }
      const data = await res.json();
      setSchema(data);
    } catch (err) {
      console.error('Schema fetch error:', err);
    } finally {
      setSchemaLoading(false);
    }
  }, []);

  // Fetch diff for the selected database
  const fetchDiff = useCallback(async (baseDumpId: string, compareDumpId: string, database?: string) => {
    try {
      setDiffLoading(true);
      const dbParam = database ? `?database=${encodeURIComponent(database)}` : '';
      const res = await fetch(`/api/dumps/${baseDumpId}/compare/${compareDumpId}${dbParam}`);
      if (!res.ok) {
        throw new Error('Failed to fetch diff');
      }
      const data: SchemaDiffResponse = await res.json();
      setDiffResult(data);
    } catch (err) {
      console.error('Diff fetch error:', err);
      setDiffError(err instanceof Error ? err.message : 'Failed to fetch diff');
    } finally {
      setDiffLoading(false);
    }
  }, []);

  // Handle database selection change
  const handleDatabaseChange = useCallback((newDb: string) => {
    if (dump && newDb !== selectedDb) {
      setSelectedDb(newDb);
      fetchSchema(dump.id, newDb);
      // Re-fetch diff if we have a comparison
      if (compareDumpId) {
        fetchDiff(dump.id, compareDumpId, newDb);
      }
    }
  }, [dump, selectedDb, fetchSchema, compareDumpId, fetchDiff]);

  // Handle compare dump file upload
  const handleCompareFileUpload = async (file: File) => {
    if (!dump) return;
    
    setCompareUploading(true);
    setDiffError(null);
    
    try {
      // Create a new dump for comparison (marked as private so it doesn't show in recents)
      const createRes = await fetch('/api/dumps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Compare: ${file.name}`, is_private: true }),
      });
      
      if (!createRes.ok) throw new Error('Failed to create comparison dump');
      const compareDump = await createRes.json();
      
      // Upload the file using FormData (same as FileUpload component)
      const formData = new FormData();
      formData.append('file', file);
      
      const uploadRes = await fetch(compareDump.upload_url || `/api/dumps/${compareDump.id}/upload`, {
        method: 'PUT',
        body: formData,
      });
      
      if (!uploadRes.ok) throw new Error('Failed to upload comparison dump');
      
      // Trigger restore
      const restoreRes = await fetch(`/api/dumps/${compareDump.id}/restore`, {
        method: 'POST',
      });
      
      if (!restoreRes.ok) throw new Error('Failed to start restore');
      
      // Wait for restore to complete (poll status)
      let status = 'RESTORING';
      let attempts = 0;
      const maxAttempts = 60; // 2 minutes max
      
      while (status !== 'READY' && status !== 'ERROR' && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const statusRes = await fetch(`/api/dumps/${compareDump.id}`);
        if (!statusRes.ok) throw new Error('Failed to check comparison dump status');
        const statusData = await statusRes.json();
        status = statusData.status;
        attempts++;
        
        if (status === 'ERROR') {
          throw new Error(statusData.error_message || 'Comparison dump restore failed');
        }
      }
      
      if (status !== 'READY') {
        throw new Error('Comparison dump processing timed out');
      }
      
      setCompareDumpId(compareDump.id);
      
      // Fetch the diff
      const dbParam = selectedDb ? `?database=${encodeURIComponent(selectedDb)}` : '';
      const diffRes = await fetch(`/api/dumps/${dump.id}/compare/${compareDump.id}${dbParam}`);
      
      if (!diffRes.ok) throw new Error('Failed to compute diff');
      const diffData: SchemaDiffResponse = await diffRes.json();
      setDiffResult(diffData);
      
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : 'Comparison failed');
    } finally {
      setCompareUploading(false);
      setCompareFile(null);
    }
  };

  // Clear comparison
  const clearComparison = async () => {
    // Optionally delete the comparison dump
    if (compareDumpId) {
      try {
        await fetch(`/api/dumps/${compareDumpId}`, { method: 'DELETE' });
      } catch {
        // Ignore errors
      }
    }
    setCompareDumpId(null);
    setDiffResult(null);
    setDiffError(null);
  };

  // Handle dump deletion
  const handleDelete = async () => {
    if (!dump) return;
    
    setDeleting(true);
    try {
      const res = await fetch(`/api/dumps/${dump.id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        throw new Error('Failed to delete dump');
      }

      // Redirect to home page after successful deletion
      router.push('/');
    } catch (err) {
      console.error('Delete error:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete dump');
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;

    const loadData = async () => {
      setLoading(true);
      const dumpData = await fetchDump();
      
      if (dumpData) {
        if (dumpData.status === 'READY') {
          // Fetch available databases first
          const dbList = await fetchDatabases(dumpData.id);
          // Determine which database to use
          const dbToUse = dbList?.primary || (dbList?.databases && dbList.databases.length > 0 ? dbList.databases[0] : undefined);
          // Set selected database if not already set
          if (dbToUse && !selectedDb) {
            setSelectedDb(dbToUse);
          }
          // Fetch schema for the selected or default database
          await fetchSchema(dumpData.id, dbToUse);
          setLoading(false);
        } else if (dumpData.status === 'RESTORING' || dumpData.status === 'UPLOADED' || dumpData.status === 'ANALYZING') {
          interval = setInterval(async () => {
            const updated = await fetchDump();
            if (updated && updated.status === 'READY') {
              const dbList = await fetchDatabases(updated.id);
              const dbToUse = dbList?.primary || (dbList?.databases && dbList.databases.length > 0 ? dbList.databases[0] : undefined);
              if (dbToUse && !selectedDb) {
                setSelectedDb(dbToUse);
              }
              await fetchSchema(updated.id, dbToUse);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchDump, fetchDatabases, fetchSchema]);

  if (loading) {
    const statusMessage = dump?.status === 'RESTORING' 
      ? 'Restoring database...' 
      : dump?.status === 'ANALYZING'
      ? 'Analyzing schema and relationships...'
      : 'Loading...';
    
    const statusDetail = (dump?.status === 'RESTORING' || dump?.status === 'ANALYZING')
      ? 'This may take a few minutes for large dumps'
      : null;

    return (
      <div className="max-w-7xl mx-auto py-12">
        <div className="flex flex-col items-center justify-center py-20">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-500 mb-4"></div>
          <p className="text-slate-500 dark:text-slate-400">
            {statusMessage}
          </p>
          {statusDetail && (
            <p className="text-sm text-slate-400 dark:text-slate-500 mt-2">
              {statusDetail}
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
          
          {/* Delete Button */}
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg transition-colors"
          >
            🗑️ Delete
          </button>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div 
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => !deleting && setShowDeleteConfirm(false)}
          />
          <div className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-2xl p-6 max-w-md m-4">
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">
              Delete Dump?
            </h3>
            <p className="text-slate-600 dark:text-slate-400 mb-4">
              This will permanently delete the dump <strong>{dump.name || 'Untitled'}</strong> and all associated data. This action cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {deleting ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Deleting...
                  </>
                ) : (
                  'Delete'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Schema Explorer */}
      {dump.status === 'READY' && schema ? (
        <>
          {/* Database Selector (only show if multiple databases available) */}
          {databases && databases.databases.length > 1 && (
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4">
              <div className="flex items-center gap-4">
                <label htmlFor="database-select" className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Database:
                </label>
                <select
                  id="database-select"
                  value={selectedDb || ''}
                  onChange={(e) => handleDatabaseChange(e.target.value)}
                  disabled={schemaLoading}
                  className="flex-1 max-w-md px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50"
                >
                  {databases.databases.map((db) => (
                    <option key={db} value={db}>
                      {db} {db === databases.primary ? '(default)' : ''}
                    </option>
                  ))}
                </select>
                {schemaLoading && (
                  <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-indigo-500"></div>
                    Loading schema...
                  </div>
                )}
                <div className="text-sm text-slate-500 dark:text-slate-400">
                  {databases.databases.length} databases available (pg_dumpall format)
                </div>
              </div>
            </div>
          )}

          {/* Tab Navigation */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700">
            <div className="border-b border-slate-200 dark:border-slate-700">
              <nav className="flex gap-4 px-6">
                <button
                  onClick={() => setActiveTab('schema')}
                  className={`py-4 px-2 font-medium text-sm border-b-2 transition-colors ${
                    activeTab === 'schema'
                      ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                      : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300'
                  }`}
                >
                  📊 Schema Explorer
                </button>
                <button
                  onClick={() => setActiveTab('search')}
                  className={`py-4 px-2 font-medium text-sm border-b-2 transition-colors ${
                    activeTab === 'search'
                      ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                      : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300'
                  }`}
                >
                  🔍 Full-Text Search
                </button>
                <button
                  onClick={() => setActiveTab('compare')}
                  className={`py-4 px-2 font-medium text-sm border-b-2 transition-colors ${
                    activeTab === 'compare'
                      ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                      : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300'
                  }`}
                >
                  🔄 Compare Dumps
                </button>
              </nav>
            </div>

            <div className="p-6">
              {activeTab === 'schema' ? (
                <SchemaExplorer 
                  dumpId={dump.id}
                  schemaGraph={schema.schema_graph}
                  fullMermaidER={schema.mermaid_er}
                  selectedDatabase={selectedDb || undefined}
                />
              ) : activeTab === 'search' ? (
                <SearchResults 
                  dumpId={dump.id}
                  databases={databases?.databases}
                />
              ) : (
                <div className="space-y-6">
                  {/* Database selector for comparison (only show if multiple databases) */}
                  {databases && databases.databases.length > 1 && (
                    <div className="flex items-center gap-4 p-4 bg-slate-50 dark:bg-slate-900 rounded-lg">
                      <label htmlFor="compare-db-select" className="text-sm font-medium text-slate-700 dark:text-slate-300">
                        Compare Database:
                      </label>
                      <select
                        id="compare-db-select"
                        value={selectedDb || ''}
                        onChange={(e) => handleDatabaseChange(e.target.value)}
                        className="flex-1 max-w-md px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      >
                        {databases.databases.map((db) => (
                          <option key={db} value={db}>
                            {db} {db === databases.primary ? '(default)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  
                  {diffResult ? (
                    <>
                      <div className="flex items-center justify-between">
                        <div className="text-sm text-slate-600 dark:text-slate-400">
                          Comparing with uploaded dump
                        </div>
                        <button
                          onClick={clearComparison}
                          className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
                        >
                          ✕ Clear Comparison
                        </button>
                      </div>
                      <DiffViewer 
                        diff={diffResult}
                        allTables={schema?.schema_graph?.tables?.map(t => ({
                          schema_name: t.schema_name,
                          table_name: t.table_name,
                          estimated_row_count: t.estimated_row_count,
                        }))}
                        onViewTableData={async (schemaName, table) => {
                          if (!dump || !compareDumpId) return null;
                          try {
                            const url = new URL(
                              `/api/dumps/${dump.id}/compare/${compareDumpId}/table/${encodeURIComponent(schemaName)}/${encodeURIComponent(table)}`,
                              window.location.origin
                            );
                            if (selectedDb) {
                              url.searchParams.set('database', selectedDb);
                            }
                            const res = await fetch(url.toString());
                            if (!res.ok) {
                              const error = await res.text();
                              console.error('Data diff error:', error);
                              return null;
                            }
                            return await res.json() as TableDataDiffResponse;
                          } catch (err) {
                            console.error('Data diff fetch error:', err);
                            return null;
                          }
                        }}
                      />
                    </>
                  ) : (
                    <div className="text-center py-12">
                      <div className="max-w-md mx-auto">
                        <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200 mb-2">
                          Compare with Another Dump
                        </h3>
                        <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
                          Upload another PostgreSQL dump to see schema differences. 
                          This is useful for comparing database changes before and after operations.
                        </p>
                        
                        {diffError && (
                          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-600 dark:text-red-400 text-sm">
                            {diffError}
                          </div>
                        )}
                        
                        <div className="border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-xl p-8 hover:border-indigo-400 dark:hover:border-indigo-500 transition-colors">
                          {compareUploading ? (
                            <div className="flex flex-col items-center">
                              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500 mb-4"></div>
                              <p className="text-slate-600 dark:text-slate-400">
                                Processing comparison dump...
                              </p>
                              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                                This may take a few minutes for large dumps
                              </p>
                            </div>
                          ) : (
                            <>
                              <input
                                type="file"
                                accept=".sql,.dump,.backup,.gz,.bz2,.xz"
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) handleCompareFileUpload(file);
                                }}
                                className="hidden"
                                id="compare-file-input"
                              />
                              <label
                                htmlFor="compare-file-input"
                                className="cursor-pointer flex flex-col items-center"
                              >
                                <svg className="w-12 h-12 text-slate-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                                </svg>
                                <span className="text-sm font-medium text-indigo-600 dark:text-indigo-400">
                                  Upload dump for comparison
                                </span>
                                <span className="text-xs text-slate-400 mt-1">
                                  .sql, .dump, .backup, .gz, .bz2, .xz
                                </span>
                              </label>
                            </>
                          )}
                        </div>
                        
                        <p className="text-xs text-slate-400 dark:text-slate-500 mt-4">
                          💡 Tip: Use pg_dump to create dump files from your PostgreSQL databases
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
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
