'use client';

import { useState, useCallback, useMemo } from 'react';
import { Upload, FileUp, Loader2, Eye, EyeOff, Table2, X, Check, ArrowRight, ArrowLeft, AlertTriangle } from 'lucide-react';

interface TablePreview {
  schema_name: string;
  table_name: string;
  estimated_size_bytes: number | null;
  row_count_hint: number | null;
  dependent_tables: string[];
}

interface FileUploadProps {
  onUploadComplete: (dumpId: string, slug: string) => void;
}

type UploadStep = 'upload' | 'select-tables' | 'restoring';

export function FileUpload({ onUploadComplete }: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  
  // New state for table selection
  const [step, setStep] = useState<UploadStep>('upload');
  const [dumpId, setDumpId] = useState<string | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [tables, setTables] = useState<TablePreview[]>([]);
  const [excludedTables, setExcludedTables] = useState<Set<string>>(new Set());
  const [isLoadingTables, setIsLoadingTables] = useState(false);

  const handleUpload = useCallback(async (file: File) => {
    setIsUploading(true);
    setProgress(0);
    setError(null);

    try {
      // Step 1: Create dump session
      const createRes = await fetch('/api/dumps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          name: name || file.name,
          is_private: isPrivate,
        }),
      });

      if (!createRes.ok) {
        throw new Error('Failed to create dump session');
      }

      const { id, slug: dumpSlug, upload_url } = await createRes.json();
      setDumpId(id);
      setSlug(dumpSlug);
      setProgress(20);

      // Step 2: Upload file
      const formData = new FormData();
      formData.append('file', file);

      const uploadRes = await fetch(upload_url, {
        method: 'PUT',
        body: formData,
      });

      if (!uploadRes.ok) {
        throw new Error('Failed to upload file');
      }

      setProgress(60);

      // Step 3: Try to preview tables
      setIsLoadingTables(true);
      try {
        const previewRes = await fetch(`/api/dumps/${id}/preview`);
        if (previewRes.ok) {
          const { tables: previewTables } = await previewRes.json();
          if (previewTables && previewTables.length > 0) {
            setTables(previewTables);
            setProgress(80);
            setStep('select-tables');
            setIsUploading(false);
            setIsLoadingTables(false);
            return;
          }
        }
      } catch {
        // If preview fails, continue with regular restore
        console.log('Table preview not available, proceeding with full restore');
      }
      setIsLoadingTables(false);

      // If no tables to preview or preview failed, proceed with restore
      await proceedWithRestore(id, dumpSlug, []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setIsUploading(false);
    }
  }, [name, isPrivate]);

  const proceedWithRestore = async (id: string, dumpSlug: string, excluded: string[]) => {
    setStep('restoring');
    setProgress(80);
    setError(null);

    try {
      // Use restore with exclusions if there are any
      const restoreUrl = excluded.length > 0
        ? `/api/dumps/${id}/restore-with-exclusions`
        : `/api/dumps/${id}/restore`;
      
      const restoreRes = await fetch(restoreUrl, {
        method: 'POST',
        headers: excluded.length > 0 ? { 'Content-Type': 'application/json' } : undefined,
        body: excluded.length > 0 ? JSON.stringify({ excluded_tables: excluded }) : undefined,
      });

      if (!restoreRes.ok) {
        throw new Error('Failed to start restore');
      }

      setProgress(100);
      onUploadComplete(id, dumpSlug);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed');
      setStep('select-tables');
    } finally {
      setIsUploading(false);
    }
  };

  const handleConfirmSelection = async () => {
    if (!dumpId || !slug) return;
    
    const excluded = Array.from(excludedTables);
    await proceedWithRestore(dumpId, slug, excluded);
  };

  const handleSkipSelection = async () => {
    if (!dumpId || !slug) return;
    await proceedWithRestore(dumpId, slug, []);
  };

  const toggleTableExclusion = (schema: string, table: string) => {
    const key = `${schema}.${table}`;
    const newExcluded = new Set(excludedTables);
    if (newExcluded.has(key)) {
      newExcluded.delete(key);
    } else {
      newExcluded.add(key);
    }
    setExcludedTables(newExcluded);
  };

  // Calculate which tables will be affected by FK constraints
  const affectedTablesInfo = useMemo(() => {
    const affected = new Map<string, string[]>(); // table -> [parent tables that caused it]
    for (const excludedKey of Array.from(excludedTables)) {
      const table = tables.find(
        (t) => `${t.schema_name}.${t.table_name}` === excludedKey
      );
      if (table && table.dependent_tables && table.dependent_tables.length > 0) {
        for (const dep of table.dependent_tables) {
          if (!excludedTables.has(dep)) {
            const existing = affected.get(dep) || [];
            existing.push(excludedKey);
            affected.set(dep, existing);
          }
        }
      }
    }
    return affected;
  }, [excludedTables, tables]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file) {
      handleUpload(file);
    }
  }, [handleUpload]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleUpload(file);
    }
  }, [handleUpload]);

  const handleReset = () => {
    setStep('upload');
    setDumpId(null);
    setSlug(null);
    setTables([]);
    setExcludedTables(new Set());
    setProgress(0);
    setError(null);
    setName('');
    setIsPrivate(false);
  };

  const formatRowCount = (count: number | null) => {
    if (count === null || count === undefined) return '-';
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
    return count.toString();
  };

  // Table selection step
  if (step === 'select-tables') {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
              Select Tables to Exclude Data
            </h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Found {tables.length} tables. Excluding data from large tables can reduce storage usage significantly.
            </p>
          </div>
          <button
            onClick={handleReset}
            className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {excludedTables.size > 0 && (
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4">
            <p className="text-sm text-blue-700 dark:text-blue-300">
              <strong>{excludedTables.size}</strong> table(s) will have their <strong>data excluded</strong>.
              Table schema (columns, indexes, foreign keys) will be preserved for analysis.
            </p>
          </div>
        )}

        <div className="max-h-96 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-xl">
          <table className="w-full bg-white dark:bg-slate-900">
            <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Data
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Schema
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Table
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Rows (approx)
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
              {tables.map((table) => {
                const key = `${table.schema_name}.${table.table_name}`;
                const isExcluded = excludedTables.has(key);
                const affectedBy = affectedTablesInfo.get(key);
                const isAffected = affectedBy && affectedBy.length > 0;
                return (
                  <tr
                    key={key}
                    className={`cursor-pointer transition-colors ${
                      isExcluded 
                        ? 'bg-red-50 dark:bg-red-900/10' 
                        : isAffected
                          ? 'bg-amber-50 dark:bg-amber-900/10'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                    onClick={() => toggleTableExclusion(table.schema_name, table.table_name)}
                  >
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                          isExcluded
                            ? 'bg-red-500 border-red-500 text-white'
                            : 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-transparent'
                        }`}
                      >
                        {isExcluded ? <X className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">
                      {table.schema_name}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Table2 className="w-4 h-4 text-slate-400" />
                        <span className={`text-sm font-medium ${
                          isExcluded 
                            ? 'text-slate-400 dark:text-slate-500 line-through' 
                            : 'text-slate-900 dark:text-white'
                        }`}>
                          {table.table_name}
                        </span>
                        {isAffected && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300" title={`FK references: ${affectedBy.join(', ')}`}>
                            <AlertTriangle className="w-3 h-3" />
                            FK affected
                          </span>
                        )}
                        {table.dependent_tables && table.dependent_tables.length > 0 && isExcluded && (
                          <span className="text-xs text-slate-400">
                            → {table.dependent_tables.length} dependent table(s)
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-slate-500 dark:text-slate-400">
                      {formatRowCount(table.row_count_hint)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* FK Warning Box */}
        {affectedTablesInfo.size > 0 && (
          <div className="mt-4 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                  Foreign Key Warning
                </h4>
                <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
                  The following tables have FK references to excluded tables and their data will also fail to import:
                </p>
                <ul className="mt-2 text-sm text-amber-700 dark:text-amber-400 list-disc list-inside">
                  {Array.from(affectedTablesInfo.entries()).map(([table, parents]) => (
                    <li key={table}>
                      <span className="font-medium">{table}</span>
                      <span className="text-amber-600 dark:text-amber-500"> (references: {parents.join(', ')})</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between pt-4">
          <button
            onClick={handleSkipSelection}
            className="px-4 py-2 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Include All Data
          </button>
          <button
            onClick={handleConfirmSelection}
            className="px-6 py-3 bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-xl hover:from-indigo-600 hover:to-purple-700 transition-all duration-200 font-medium shadow-lg hover:shadow-xl flex items-center gap-2"
          >
            {excludedTables.size > 0 ? (
              <>
                Skip Data for {excludedTables.size} Table(s)
                <ArrowRight className="w-4 h-4" />
              </>
            ) : (
              <>
                Include All Data
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>

        {error && (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-xl border border-red-200 dark:border-red-800 flex items-center">
            <svg className="w-5 h-5 mr-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {error}
          </div>
        )}
      </div>
    );
  }

  // Restoring step
  if (step === 'restoring') {
    return (
      <div className="space-y-6">
        <div className="text-center p-10">
          <Loader2 className="w-14 h-14 mx-auto text-indigo-500 animate-spin" />
          <p className="text-slate-600 dark:text-slate-400 font-medium mt-4">
            Restoring database... {progress}%
          </p>
          {excludedTables.size > 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-500 mt-2">
              Excluding {excludedTables.size} table(s) from restore
            </p>
          )}
          <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2 overflow-hidden mt-4">
            <div
              className="bg-gradient-to-r from-indigo-500 to-purple-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>
    );
  }

  // Default upload step
  return (
    <div className="space-y-6">
      <div>
        <label htmlFor="dump-name" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Dump Name <span className="text-slate-400 dark:text-slate-500">(optional)</span>
        </label>
        <input
          id="dump-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-database-snapshot"
          className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-xl text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
          disabled={isUploading}
        />
      </div>

      {/* Private option */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setIsPrivate(!isPrivate)}
          disabled={isUploading}
          className={`
            relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent 
            transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2
            ${isPrivate ? 'bg-indigo-600' : 'bg-slate-200 dark:bg-slate-700'}
            ${isUploading ? 'opacity-50 cursor-not-allowed' : ''}
          `}
        >
          <span
            className={`
              pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 
              transition duration-200 ease-in-out
              ${isPrivate ? 'translate-x-5' : 'translate-x-0'}
            `}
          />
        </button>
        <div className="flex items-center gap-2">
          {isPrivate ? (
            <EyeOff className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
          ) : (
            <Eye className="w-4 h-4 text-slate-400" />
          )}
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Private upload
          </label>
        </div>
      </div>
      {isPrivate && (
        <p className="text-xs text-slate-500 dark:text-slate-400 -mt-4 ml-14">
          This dump will not appear in &quot;Recent Dumps&quot;. Only those with the URL can access it.
        </p>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`
          border-2 border-dashed rounded-2xl p-10 text-center transition-all duration-200
          ${isDragging 
            ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20' 
            : 'border-slate-300 dark:border-slate-600 hover:border-indigo-400 dark:hover:border-indigo-500'
          }
          ${isUploading ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
        `}
      >
        {isUploading ? (
          <div className="space-y-4">
            <Loader2 className="w-14 h-14 mx-auto text-indigo-500 animate-spin" />
            <p className="text-slate-600 dark:text-slate-400 font-medium">
              {isLoadingTables ? 'Analyzing tables...' : 'Uploading...'} {progress}%
            </p>
            <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2 overflow-hidden">
              <div
                className="bg-gradient-to-r from-indigo-500 to-purple-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : (
          <>
            <div className="w-16 h-16 mx-auto mb-4 bg-slate-100 dark:bg-slate-800 rounded-2xl flex items-center justify-center">
              <Upload className="w-8 h-8 text-slate-400 dark:text-slate-500" />
            </div>
            <p className="text-slate-700 dark:text-slate-300 font-medium mb-2">
              Drag and drop a PostgreSQL dump file here
            </p>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
              Supports .sql, .dump, .backup, .gz, .zip files up to 5GB
            </p>
            <label className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-xl cursor-pointer hover:from-indigo-600 hover:to-purple-700 transition-all duration-200 font-medium shadow-lg hover:shadow-xl">
              <FileUp className="w-5 h-5" />
              Select File
              <input
                type="file"
                accept=".sql,.dump,.backup,.gz,.zip"
                onChange={handleFileSelect}
                className="hidden"
              />
            </label>
          </>
        )}
      </div>

      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-xl border border-red-200 dark:border-red-800 flex items-center">
          <svg className="w-5 h-5 mr-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {error}
        </div>
      )}
    </div>
  );
}
