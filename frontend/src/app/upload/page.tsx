'use client';

import { useRouter } from 'next/navigation';
import { FileUpload } from '@/components/FileUpload';

export default function UploadPage() {
  const router = useRouter();

  const handleUploadComplete = (dumpId: string, slug: string) => {
    router.push(`/d/${slug}`);
  };

  return (
    <div className="max-w-2xl mx-auto py-8">
      <div className="text-center mb-8">
        <h2 className="text-3xl font-bold text-slate-900 dark:text-white mb-3">
          Upload Database Dump
        </h2>
        <p className="text-slate-600 dark:text-slate-400">
          Upload your PostgreSQL dump file to visualize and explore your database schema.
        </p>
      </div>
      
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 p-8">
        <FileUpload onUploadComplete={handleUploadComplete} />
      </div>
      
      <div className="mt-8 bg-slate-50 dark:bg-slate-800/50 rounded-2xl p-6 border border-slate-200 dark:border-slate-700">
        <h3 className="font-semibold text-slate-900 dark:text-white mb-4 flex items-center">
          <svg className="w-5 h-5 mr-2 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Supported Formats
        </h3>
        <ul className="space-y-3">
          <li className="flex items-center text-slate-600 dark:text-slate-400">
            <span className="w-2 h-2 bg-green-500 rounded-full mr-3"></span>
            PostgreSQL SQL dumps (.sql)
          </li>
          <li className="flex items-center text-slate-600 dark:text-slate-400">
            <span className="w-2 h-2 bg-green-500 rounded-full mr-3"></span>
            PostgreSQL custom format dumps (.dump, .backup)
          </li>
          <li className="flex items-center text-slate-600 dark:text-slate-400">
            <span className="w-2 h-2 bg-green-500 rounded-full mr-3"></span>
            Compressed archives (.gz, .zip)
          </li>
        </ul>
      </div>
    </div>
  );
}
