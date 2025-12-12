import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RiskBadge } from './RiskBadge';

describe('RiskBadge', () => {
  it('renders low risk correctly', () => {
    const risk = {
      score: 15,
      level: 'low' as const,
      reasons: [],
    };

    render(<RiskBadge risk={risk} />);

    expect(screen.getByText('low')).toBeInTheDocument();
    expect(screen.getByText('(15/100)')).toBeInTheDocument();
  });

  it('renders high risk correctly', () => {
    const risk = {
      score: 70,
      level: 'high' as const,
      reasons: ['Has CASCADE delete'],
    };

    render(<RiskBadge risk={risk} />);

    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('(70/100)')).toBeInTheDocument();
  });

  it('renders critical risk correctly', () => {
    const risk = {
      score: 95,
      level: 'critical' as const,
      reasons: ['Multiple CASCADE deletes', 'Large table'],
    };

    render(<RiskBadge risk={risk} />);

    expect(screen.getByText('critical')).toBeInTheDocument();
  });

  it('shows reasons when showReasons is true', () => {
    const risk = {
      score: 50,
      level: 'medium' as const,
      reasons: ['Referenced by 3 tables'],
    };

    render(<RiskBadge risk={risk} showReasons />);

    expect(screen.getByText('Referenced by 3 tables')).toBeInTheDocument();
  });

  it('does not show reasons when showReasons is false', () => {
    const risk = {
      score: 50,
      level: 'medium' as const,
      reasons: ['Referenced by 3 tables'],
    };

    render(<RiskBadge risk={risk} showReasons={false} />);

    expect(screen.queryByText('Referenced by 3 tables')).not.toBeInTheDocument();
  });
});
