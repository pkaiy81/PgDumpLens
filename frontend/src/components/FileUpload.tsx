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
    <div className="space-y-4">
      <div>
        <label htmlFor="dump-name" className="block text-sm font-medium mb-1">
          Dump Name (optional)
        </label>
        <input
          id="dump-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-database-snapshot"
          className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
          disabled={isUploading}
        />
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`
          border-2 border-dashed rounded-lg p-8 text-center transition
          ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300'}
          ${isUploading ? 'pointer-events-none opacity-50' : 'cursor-pointer hover:border-gray-400'}
        `}
      >
        {isUploading ? (
          <div className="space-y-3">
            <Loader2 className="w-12 h-12 mx-auto text-blue-500 animate-spin" />
            <p className="text-gray-600">Uploading... {progress}%</p>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : (
          <>
            <Upload className="w-12 h-12 mx-auto text-gray-400 mb-4" />
            <p className="text-gray-600 mb-2">
              Drag and drop a PostgreSQL dump file here
            </p>
            <p className="text-sm text-gray-400 mb-4">
              or click to browse (.sql, .dump, .backup)
            </p>
            <label className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg cursor-pointer hover:bg-blue-700">
              <FileUp className="w-4 h-4" />
              Select File
              <input
                type="file"
                accept=".sql,.dump,.backup"
                onChange={handleFileSelect}
                className="hidden"
              />
            </label>
          </>
        )}
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-600 rounded-lg">
          {error}
        </div>
      )}
    </div>
  );
}
