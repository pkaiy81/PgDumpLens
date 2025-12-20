'use client';

import { useEffect, useState } from 'react';
import { RiskScore as RiskScoreType, RiskLevel } from '@/types';
import { getRiskColor } from '@/lib/utils';
import { AlertTriangle, Info, AlertCircle, XCircle, Loader2 } from 'lucide-react';

export interface RiskBadgeProps {
  dumpId: string;
  schema: string;
  table: string;
  showReasons?: boolean;
}

const RiskIcon = ({ level }: { level: RiskLevel }) => {
  const iconClass = 'w-4 h-4';
  switch (level) {
    case 'low':
      return <Info className={iconClass} />;
    case 'medium':
      return <AlertCircle className={iconClass} />;
    case 'high':
      return <AlertTriangle className={iconClass} />;
    case 'critical':
      return <XCircle className={iconClass} />;
  }
};

export function RiskBadge({ dumpId, schema, table, showReasons = false }: RiskBadgeProps) {
  const [risk, setRisk] = useState<RiskScoreType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchRisk = async () => {
      setLoading(true);
      setError(null);
      try {
        const apiBase = process.env.NEXT_PUBLIC_API_URL || '';
        const response = await fetch(`${apiBase}/api/dumps/${dumpId}/risk/table/${schema}/${table}`);
        if (!response.ok) {
          throw new Error('Failed to fetch risk');
        }
        const data = await response.json();
        setRisk(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch risk');
      } finally {
        setLoading(false);
      }
    };

    fetchRisk();
  }, [dumpId, schema, table]);

  if (loading) {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-100 dark:bg-slate-700">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm text-slate-500">Loading...</span>
      </div>
    );
  }

  if (error || !risk) {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-100 dark:bg-slate-700">
        <span className="text-sm text-slate-500">N/A</span>
      </div>
    );
  }

  const colorClass = getRiskColor(risk.level);

  // Get risk level label
  const getRiskLabel = (level: RiskLevel): string => {
    switch (level) {
      case 'low': return 'Low';
      case 'medium': return 'Medium';
      case 'high': return 'High';
      case 'critical': return 'Critical';
    }
  };

  return (
    <div className="space-y-3">
      {/* Risk Badge */}
      <div className="flex items-center gap-3">
        <div
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg shadow-sm ${colorClass}`}
        >
          <RiskIcon level={risk.level} />
          <span className="font-bold">{getRiskLabel(risk.level)}</span>
          <span className="font-mono font-bold text-sm">
            {risk.score}/100
          </span>
        </div>
      </div>
      
      {/* Risk Score Explanation */}
      <div className="text-xs text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 rounded-lg px-3 py-2 max-w-md">
        <span className="font-semibold">Deletion Risk Score:</span> Indicates the potential impact of deleting data from this table. 
        Higher scores mean more cascading effects on related tables.
      </div>

      {showReasons && risk.reasons.length > 0 && (
        <ul className="text-sm text-slate-600 dark:text-slate-400 space-y-1 ml-4">
          {risk.reasons.map((reason, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="text-slate-400 dark:text-slate-500">•</span>
              {reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
