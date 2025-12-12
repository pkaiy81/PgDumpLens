'use client';

import { useRouter } from 'next/navigation';
import { FileUpload } from '@/components/FileUpload';

export default function UploadPage() {
  const router = useRouter();

  const handleUploadComplete = (dumpId: string, slug: string) => {
    router.push(`/d/${slug}`);
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Upload Database Dump</h2>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <FileUpload onUploadComplete={handleUploadComplete} />
      </div>
      <div className="mt-6 text-sm text-gray-500">
        <h3 className="font-medium mb-2">Supported formats:</h3>
        <ul className="list-disc list-inside space-y-1">
          <li>PostgreSQL SQL dumps (.sql)</li>
          <li>PostgreSQL custom format dumps (.dump, .backup)</li>
        </ul>
      </div>
    </div>
  );
}
