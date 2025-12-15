'use client';

import { useState, useCallback } from 'react';
import { Upload, FileUp, Loader2 } from 'lucide-react';

interface FileUploadProps {
  onUploadComplete: (dumpId: string, slug: string) => void;
}

export function FileUpload({ onUploadComplete }: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');

  const handleUpload = useCallback(async (file: File) => {
    setIsUploading(true);
    setProgress(0);
    setError(null);

    try {
      // Step 1: Create dump session
      const createRes = await fetch('/api/dumps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || file.name }),
      });

      if (!createRes.ok) {
        throw new Error('Failed to create dump session');
      }

      const { id, slug, upload_url } = await createRes.json();
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

      // Step 3: Trigger restore
      const restoreRes = await fetch(`/api/dumps/${id}/restore`, {
        method: 'POST',
      });

      if (!restoreRes.ok) {
        throw new Error('Failed to start restore');
      }

      setProgress(100);
      onUploadComplete(id, slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  }, [name, onUploadComplete]);

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
            <p className="text-slate-600 dark:text-slate-400 font-medium">Uploading... {progress}%</p>
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
