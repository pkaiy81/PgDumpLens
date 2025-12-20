import { describe, it, expect } from 'vitest';
import { formatDistanceToNow, formatBytes, getRiskColor, parseTablePath } from './utils';

describe('formatDistanceToNow', () => {
  it('should return "just now" for recent dates', () => {
    const now = new Date();
    expect(formatDistanceToNow(now)).toBe('just now');
  });

  it('should return minutes ago for dates within an hour', () => {
    const date = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
    expect(formatDistanceToNow(date)).toBe('30 minutes ago');
  });

  it('should return hours ago for dates within a day', () => {
    const date = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    expect(formatDistanceToNow(date)).toBe('2 hours ago');
  });

  it('should return days ago for older dates', () => {
    const date = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
    expect(formatDistanceToNow(date)).toBe('3 days ago');
  });

  it('should handle singular correctly', () => {
    const date = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
    expect(formatDistanceToNow(date)).toBe('1 day ago');
  });
});

describe('formatBytes', () => {
  it('should return "0 Bytes" for 0', () => {
    expect(formatBytes(0)).toBe('0 Bytes');
  });

  it('should format bytes correctly', () => {
    expect(formatBytes(500)).toBe('500 Bytes');
  });

  it('should format kilobytes correctly', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(2048)).toBe('2 KB');
  });

  it('should format megabytes correctly', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(5.5 * 1024 * 1024)).toBe('5.5 MB');
  });

  it('should format gigabytes correctly', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
  });
});

describe('getRiskColor', () => {
  it('should return correct color for low risk', () => {
    expect(getRiskColor('low')).toContain('green');
  });

  it('should return correct color for medium risk', () => {
    expect(getRiskColor('medium')).toContain('yellow');
  });

  it('should return correct color for high risk', () => {
    expect(getRiskColor('high')).toContain('orange');
  });

  it('should return correct color for critical risk', () => {
    expect(getRiskColor('critical')).toContain('red');
  });

  it('should return default for unknown risk', () => {
    expect(getRiskColor('unknown')).toContain('slate');
  });
});

describe('parseTablePath', () => {
  it('should parse schema.table format', () => {
    const result = parseTablePath('public.users');
    expect(result.schema).toBe('public');
    expect(result.table).toBe('users');
  });

  it('should use public as default schema', () => {
    const result = parseTablePath('users');
    expect(result.schema).toBe('public');
    expect(result.table).toBe('users');
  });

  it('should handle different schema names', () => {
    const result = parseTablePath('sales.orders');
    expect(result.schema).toBe('sales');
    expect(result.table).toBe('orders');
  });
});
