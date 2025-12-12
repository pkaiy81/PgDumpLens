import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'DB Viewer - Database Dump Visualization',
  description: 'Visualize database dumps with ER diagrams, relationship exploration, and risk assessment',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <div className="min-h-screen">
          <header className="bg-white dark:bg-gray-900 shadow">
            <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
              <div className="flex items-center justify-between">
                <h1 className="text-xl font-bold text-gray-900 dark:text-white">
                  DB Viewer
                </h1>
                <nav className="flex space-x-4">
                  <a href="/" className="text-gray-600 hover:text-gray-900 dark:text-gray-300">
                    Home
                  </a>
                  <a href="/upload" className="text-gray-600 hover:text-gray-900 dark:text-gray-300">
                    Upload
                  </a>
                </nav>
              </div>
            </div>
          </header>
          <main className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
