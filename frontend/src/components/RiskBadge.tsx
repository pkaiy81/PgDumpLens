'use client';

import { RiskScore as RiskScoreType, RiskLevel } from '@/types';
import { getRiskColor } from '@/lib/utils';
import { AlertTriangle, Info, AlertCircle, XCircle } from 'lucide-react';

interface RiskBadgeProps {
  risk: RiskScoreType;
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

export function RiskBadge({ risk, showReasons = false }: RiskBadgeProps) {
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
