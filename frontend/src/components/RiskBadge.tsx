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

  return (
    <div className="space-y-2">
      <div
        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full ${colorClass}`}
      >
        <RiskIcon level={risk.level} />
        <span className="font-medium capitalize">{risk.level}</span>
        <span className="text-sm opacity-75">({risk.score}/100)</span>
      </div>
      {showReasons && risk.reasons.length > 0 && (
        <ul className="text-sm text-gray-600 space-y-1 ml-4">
          {risk.reasons.map((reason, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="text-gray-400">•</span>
              {reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
