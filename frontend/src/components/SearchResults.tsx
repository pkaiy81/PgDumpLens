"use client";

import { useState } from "react";
import { Search, Database, Table, Columns, Copy, Check } from "lucide-react";

interface SearchResult {
  database_name: string;
  schema_name: string;
  table_name: string;
  column_name: string;
  matched_value: any;
  row_data: any;
  sql_query: string;
}

interface SearchResponse {
  query: string;
  total_results: number;
  results: SearchResult[];
  searched_tables: number;
}

interface SearchResultsProps {
  dumpId: string;
  databases?: string[];
}

export default function SearchResults({ dumpId, databases }: SearchResultsProps) {
  const [query, setQuery] = useState("");
  const [selectedDatabase, setSelectedDatabase] = useState<string>("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleSearch = async () => {
    if (!query.trim()) {
      return;
    }

    setSearching(true);
    setError(null);

    try {
      const params = new URLSearchParams({ q: query });
      if (selectedDatabase) {
        params.append("database", selectedDatabase);
      }

      const response = await fetch(
        `/api/dumps/${dumpId}/search?${params}`
      );

      if (!response.ok) {
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Search failed");
        } else {
          const errorText = await response.text();
          console.error("Non-JSON error response:", errorText);
          throw new Error(`Search failed: ${response.status} ${response.statusText}`);
        }
      }

      const data: SearchResponse = await response.json();
      setResults(data);
    } catch (err) {
      console.error("Search error:", err);
      setError(err instanceof Error ? err.message : "Search failed");
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const copyToClipboard = async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const formatValue = (value: any): string => {
    if (value === null || value === undefined) {
      return "null";
    }
    if (typeof value === "object") {
      return JSON.stringify(value, null, 2);
    }
    return String(value);
  };

  return (
    <div className="space-y-4">
      {/* Search Input */}
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500" size={20} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Search across all tables (e.g., hostname, email, ID...)"
            className="w-full pl-10 pr-4 py-2 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={searching}
          />
        </div>

        {databases && databases.length > 1 && (
          <select
            value={selectedDatabase}
            onChange={(e) => setSelectedDatabase(e.target.value)}
            className="px-4 py-2 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={searching}
          >
            <option value="">All Databases</option>
            {databases.map((db) => (
              <option key={db} value={db}>
                {db}
              </option>
            ))}
          </select>
        )}

        <button
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
        >
          {searching ? "Searching..." : "Search"}
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
          {error}
        </div>
      )}

      {/* Results Summary */}
      {results && (
        <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <p className="text-sm text-blue-900 dark:text-blue-200">
            Found <strong>{results.total_results}</strong> result(s) for &quot;<strong>{results.query}</strong>&quot; 
            (searched {results.searched_tables} table(s))
          </p>
        </div>
      )}

      {/* Search Results */}
      {results && results.results.length > 0 && (
        <div className="space-y-3">
          {results.results.map((result, index) => (
            <div key={index} className="border border-gray-200 dark:border-slate-700 rounded-lg p-4 bg-white dark:bg-slate-800 hover:shadow-md transition-shadow">
              {/* Location Info */}
              <div className="flex items-start gap-2 mb-3 text-sm">
                <Database size={16} className="text-blue-600 dark:text-blue-400 mt-0.5" />
                <div className="flex-1">
                  <span className="font-semibold text-blue-900 dark:text-blue-300">{result.database_name}</span>
                  <span className="mx-1 text-gray-400 dark:text-gray-500">›</span>
                  <span className="text-gray-700 dark:text-gray-300">{result.schema_name}</span>
                  <span className="mx-1 text-gray-400 dark:text-gray-500">›</span>
                  <span className="font-medium text-gray-900 dark:text-white">{result.table_name}</span>
                  <span className="mx-1 text-gray-400 dark:text-gray-500">›</span>
                  <span className="text-purple-600 dark:text-purple-400">{result.column_name}</span>
                </div>
              </div>

              {/* Matched Value */}
              <div className="mb-3">
                <div className="text-xs text-gray-600 dark:text-gray-400 mb-1 font-medium">Matched Value:</div>
                <div className="p-2 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded font-mono text-sm text-gray-900 dark:text-yellow-200">
                  {formatValue(result.matched_value)}
                </div>
              </div>

              {/* Full Row Data */}
              <details className="mb-3">
                <summary className="text-xs text-gray-600 dark:text-gray-400 cursor-pointer hover:text-gray-900 dark:hover:text-gray-200 font-medium">
                  Show full row data
                </summary>
                <pre className="mt-2 p-2 bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded text-xs overflow-x-auto text-gray-900 dark:text-gray-200">
                  {JSON.stringify(result.row_data, null, 2)}
                </pre>
              </details>

              {/* SQL Query */}
              <div className="relative">
                <div className="text-xs text-gray-600 dark:text-gray-400 mb-1 font-medium">SQL to reproduce this search:</div>
                <div className="relative">
                  <pre className="p-3 bg-gray-900 dark:bg-slate-950 text-gray-100 dark:text-gray-200 rounded text-xs overflow-x-auto border border-gray-700 dark:border-slate-800">
                    {result.sql_query}
                  </pre>
                  <button
                    onClick={() => copyToClipboard(result.sql_query, index)}
                    className="absolute top-2 right-2 p-1.5 bg-gray-700 dark:bg-slate-700 hover:bg-gray-600 dark:hover:bg-slate-600 rounded text-white transition-colors"
                    title="Copy SQL"
                  >
                    {copiedIndex === index ? (
                      <Check size={14} />
                    ) : (
                      <Copy size={14} />
                    )}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* No Results */}
      {results && results.results.length === 0 && (
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">
          No results found for &quot;{results.query}&quot;
        </div>
      )}
    </div>
  );
}
