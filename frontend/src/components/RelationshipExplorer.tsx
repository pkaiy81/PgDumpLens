'use client';

import { useState, useEffect } from 'react';
import { X, ArrowRight, ArrowLeft, Database, AlertTriangle, Copy, Check } from 'lucide-react';

interface RelationExplanation {
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
  direction: 'inbound' | 'outbound';
  path_length: number;
  sample_rows: unknown[];
  sql_example: string;
  risk_score: number;
  risk_reasons: string[];
}

interface ExplainRelationResponse {
  explanations: RelationExplanation[];
  sql_examples: string[];
}

interface RelationshipExplorerProps {
  isOpen: boolean;
  onClose: () => void;
  dumpId: string;
  schema: string;
  table: string;
  column: string;
  value: unknown;
}

export function RelationshipExplorer({
  isOpen,
  onClose,
  dumpId,
  schema,
  table,
  column,
  value,
}: RelationshipExplorerProps) {
  const [data, setData] = useState<ExplainRelationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const fetchRelationships = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/dumps/${dumpId}/relation/explain`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schema,
            table,
            column,
            value,
            max_hops: 2,
          }),
        });

        if (!res.ok) {
          throw new Error('Failed to fetch relationship data');
        }

        const json = await res.json();
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error fetching relationships');
      } finally {
        setLoading(false);
      }
    };

    fetchRelationships();
  }, [isOpen, dumpId, schema, table, column, value]);

  const handleCopySQL = async (sql: string, index: number) => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch {
      console.error('Failed to copy SQL');
    }
  };

  const formatValue = (val: unknown): string => {
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  };

  const getRiskColor = (score: number): string => {
    if (score >= 75) return 'text-red-600 dark:text-red-400';
    if (score >= 50) return 'text-orange-600 dark:text-orange-400';
    if (score >= 25) return 'text-yellow-600 dark:text-yellow-400';
    return 'text-green-600 dark:text-green-400';
  };

  if (!isOpen) return null;

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
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-100 dark:bg-indigo-900/50 rounded-lg">
              <Database className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                Relationship Explorer
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                <span className="font-mono">{schema}.{table}.{column}</span>
                {' = '}
                <span className="font-mono text-indigo-600 dark:text-indigo-400">
                  {formatValue(value)}
                </span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto p-4 max-h-[calc(85vh-80px)]">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-500 mb-4"></div>
              <p className="text-slate-500 dark:text-slate-400">Analyzing relationships...</p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          {data && !loading && (
            <div className="space-y-6">
              {/* Summary */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
                  <div className="flex items-center gap-2 mb-1">
                    <ArrowLeft className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <span className="font-medium text-blue-700 dark:text-blue-300">Inbound References</span>
                  </div>
                  <p className="text-2xl font-bold text-blue-800 dark:text-blue-200">
                    {data.explanations.filter(e => e.direction === 'inbound').length}
                  </p>
                  <p className="text-xs text-blue-600 dark:text-blue-400">
                    Tables referencing this value
                  </p>
                </div>
                <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4 border border-purple-200 dark:border-purple-800">
                  <div className="flex items-center gap-2 mb-1">
                    <ArrowRight className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                    <span className="font-medium text-purple-700 dark:text-purple-300">Outbound References</span>
                  </div>
                  <p className="text-2xl font-bold text-purple-800 dark:text-purple-200">
                    {data.explanations.filter(e => e.direction === 'outbound').length}
                  </p>
                  <p className="text-xs text-purple-600 dark:text-purple-400">
                    Tables this value references
                  </p>
                </div>
              </div>

              {/* No relationships */}
              {data.explanations.length === 0 && (
                <div className="text-center py-8 text-slate-500 dark:text-slate-400">
                  <Database className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>No foreign key relationships found for this column.</p>
                </div>
              )}

              {/* Relationship Cards */}
              {data.explanations.length > 0 && (
                <div className="space-y-4">
                  <h3 className="font-semibold text-slate-900 dark:text-white">
                    Relationships ({data.explanations.length})
                  </h3>
                  
                  {data.explanations.map((rel, idx) => (
                    <div
                      key={idx}
                      className="bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden"
                    >
                      {/* Relationship Header */}
                      <div className="flex items-center justify-between p-4 border-b border-slate-200 dark:border-slate-700">
                        <div className="flex items-center gap-3">
                          {rel.direction === 'inbound' ? (
                            <div className="p-1.5 bg-blue-100 dark:bg-blue-900/50 rounded">
                              <ArrowLeft className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                            </div>
                          ) : (
                            <div className="p-1.5 bg-purple-100 dark:bg-purple-900/50 rounded">
                              <ArrowRight className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                            </div>
                          )}
                          <div>
                            <div className="flex items-center gap-2 text-sm">
                              <span className="font-mono font-medium text-slate-900 dark:text-white">
                                {rel.source_table}
                              </span>
                              <span className="text-slate-400">→</span>
                              <span className="font-mono font-medium text-slate-900 dark:text-white">
                                {rel.target_table}
                              </span>
                            </div>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                              {rel.source_column} → {rel.target_column}
                            </p>
                          </div>
                        </div>
                        
                        {rel.direction === 'inbound' && rel.risk_score > 0 && (
                          <div className={`flex items-center gap-1 text-sm font-medium ${getRiskColor(rel.risk_score)}`}>
                            <AlertTriangle className="w-4 h-4" />
                            <span>Risk: {rel.risk_score}/100</span>
                          </div>
                        )}
                      </div>

                      {/* Risk Reasons */}
                      {rel.risk_reasons.length > 0 && (
                        <div className="px-4 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-slate-200 dark:border-slate-700">
                          <p className="text-xs font-medium text-amber-700 dark:text-amber-300 mb-1">
                            Risk Factors:
                          </p>
                          <ul className="text-xs text-amber-600 dark:text-amber-400 space-y-0.5">
                            {rel.risk_reasons.map((reason, i) => (
                              <li key={i}>• {reason}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* SQL Example */}
                      <div className="p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                            SQL Example
                          </span>
                          <button
                            onClick={() => handleCopySQL(rel.sql_example, idx)}
                            className="flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                          >
                            {copiedIndex === idx ? (
                              <>
                                <Check className="w-3 h-3" />
                                Copied!
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                Copy
                              </>
                            )}
                          </button>
                        </div>
                        <pre className="bg-slate-900 text-slate-100 p-3 rounded-lg text-xs overflow-x-auto font-mono">
                          {rel.sql_example.replace('$1', formatValue(value))}
                        </pre>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Additional SQL Examples */}
              {data.sql_examples.length > 0 && (
                <div className="space-y-3">
                  <h3 className="font-semibold text-slate-900 dark:text-white">
                    Additional SQL Examples
                  </h3>
                  {data.sql_examples.map((sql, idx) => (
                    <div key={idx} className="bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                          Query {idx + 1}
                        </span>
                        <button
                          onClick={() => handleCopySQL(sql, 1000 + idx)}
                          className="flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                          {copiedIndex === 1000 + idx ? (
                            <>
                              <Check className="w-3 h-3" />
                              Copied!
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              Copy
                            </>
                          )}
                        </button>
                      </div>
                      <pre className="bg-slate-900 text-slate-100 p-3 rounded-lg text-xs overflow-x-auto font-mono">
                        {sql.replace('$1', formatValue(value))}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
