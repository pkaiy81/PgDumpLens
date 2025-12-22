'use client';

import { X, Copy, Check } from 'lucide-react';
import { useState } from 'react';

interface JsonViewerProps {
  isOpen: boolean;
  onClose: () => void;
  value: unknown;
  column: string;
  table: string;
  schema: string;
}

export function JsonViewer({
  isOpen,
  onClose,
  value,
  column,
  table,
  schema,
}: JsonViewerProps) {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const isJsonValue = (val: unknown): boolean => {
    if (typeof val === 'object' && val !== null) return true;
    if (typeof val === 'string') {
      try {
        JSON.parse(val);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  };

  const formatJson = (val: unknown): string => {
    try {
      if (typeof val === 'string') {
        const parsed = JSON.parse(val);
        return JSON.stringify(parsed, null, 2);
      }
      return JSON.stringify(val, null, 2);
    } catch {
      return String(val);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formatJson(value));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      console.error('Failed to copy');
    }
  };

  const formatted = formatJson(value);
  const isJson = isJsonValue(value);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] overflow-hidden m-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              {isJson ? '📋 JSON Value' : '📄 Value Viewer'}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              <span className="font-mono">{schema}.{table}.{column}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-lg transition-colors"
            >
              {copied ? (
                <>
                  <Check className="w-4 h-4" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" />
                  Copy
                </>
              )}
            </button>
            <button
              onClick={onClose}
              className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-slate-500" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="overflow-y-auto p-4 max-h-[calc(85vh-80px)]">
          {isJson ? (
            <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg text-sm overflow-x-auto font-mono whitespace-pre-wrap break-words">
              {formatted}
            </pre>
          ) : (
            <div className="bg-slate-50 dark:bg-slate-900 p-4 rounded-lg border border-slate-200 dark:border-slate-700">
              <p className="text-slate-900 dark:text-white whitespace-pre-wrap break-words font-mono text-sm">
                {String(value)}
              </p>
            </div>
          )}

          {/* Metadata */}
          <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
              <div className="text-blue-600 dark:text-blue-400 font-medium mb-1">Type</div>
              <div className="text-blue-800 dark:text-blue-200">
                {typeof value === 'object' ? (Array.isArray(value) ? 'Array' : 'Object') : typeof value}
              </div>
            </div>
            <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 border border-purple-200 dark:border-purple-800">
              <div className="text-purple-600 dark:text-purple-400 font-medium mb-1">Length</div>
              <div className="text-purple-800 dark:text-purple-200">
                {formatted.length.toLocaleString()} characters
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
