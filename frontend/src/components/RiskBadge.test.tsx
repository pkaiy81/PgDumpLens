import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RiskBadge } from './RiskBadge';

describe('RiskBadge', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders low risk correctly', async () => {
    const risk = {
      score: 15,
      level: 'low' as const,
      reasons: [],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => risk,
    });

    render(<RiskBadge dumpId="test-id" schema="public" table="users" />);

    await waitFor(() => {
      expect(screen.getByText('low')).toBeInTheDocument();
    });
    expect(screen.getByText('(15/100)')).toBeInTheDocument();
  });

  it('renders high risk correctly', async () => {
    const risk = {
      score: 70,
      level: 'high' as const,
      reasons: ['Has CASCADE delete'],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => risk,
    });

    render(<RiskBadge dumpId="test-id" schema="public" table="orders" />);

    await waitFor(() => {
      expect(screen.getByText('high')).toBeInTheDocument();
    });
    expect(screen.getByText('(70/100)')).toBeInTheDocument();
  });

  it('renders critical risk correctly', async () => {
    const risk = {
      score: 95,
      level: 'critical' as const,
      reasons: ['Multiple CASCADE deletes', 'Large table'],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => risk,
    });

    render(<RiskBadge dumpId="test-id" schema="public" table="critical_table" />);

    await waitFor(() => {
      expect(screen.getByText('critical')).toBeInTheDocument();
    });
  });

  it('shows reasons when showReasons is true', async () => {
    const risk = {
      score: 50,
      level: 'medium' as const,
      reasons: ['Referenced by 3 tables'],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => risk,
    });

    render(<RiskBadge dumpId="test-id" schema="public" table="products" showReasons />);

    await waitFor(() => {
      expect(screen.getByText('Referenced by 3 tables')).toBeInTheDocument();
    });
  });

  it('does not show reasons when showReasons is false', async () => {
    const risk = {
      score: 50,
      level: 'medium' as const,
      reasons: ['Referenced by 3 tables'],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => risk,
    });

    render(<RiskBadge dumpId="test-id" schema="public" table="products" showReasons={false} />);

    await waitFor(() => {
      expect(screen.getByText('medium')).toBeInTheDocument();
    });
    expect(screen.queryByText('Referenced by 3 tables')).not.toBeInTheDocument();
  });

  it('shows loading state', () => {
    mockFetch.mockImplementation(() => new Promise(() => {})); // Never resolves

    render(<RiskBadge dumpId="test-id" schema="public" table="users" />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows N/A on error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
    });

    render(<RiskBadge dumpId="test-id" schema="public" table="users" />);

    await waitFor(() => {
      expect(screen.getByText('N/A')).toBeInTheDocument();
    });
  });
});
