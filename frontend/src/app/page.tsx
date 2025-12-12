import Link from 'next/link';
import { DumpList } from '@/components/DumpList';

export default function Home() {
  return (
    <div className="space-y-8">
      <section className="text-center py-12">
        <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">
          Database Dump Visualization
        </h2>
        <p className="text-lg text-gray-600 dark:text-gray-400 mb-8 max-w-2xl mx-auto">
          Upload a PostgreSQL dump to visualize schema, explore relationships,
          and understand the risk of data modifications.
        </p>
        <Link
          href="/upload"
          className="inline-flex items-center px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
        >
          Upload New Dump
        </Link>
      </section>

      <section>
        <h3 className="text-xl font-semibold mb-4">Recent Dumps</h3>
        <DumpList />
      </section>
    </div>
  );
}
