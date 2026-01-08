import clsx from 'clsx';

export { clsx };

/**
 * Format a date to a relative time string (e.g., "2 hours ago")
 */
export function formatDistanceToNow(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  }
  if (diffHours > 0) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  }
  if (diffMins > 0) {
    return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

/**
 * Format bytes to human-readable size
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Generate a color for a risk level
 * Uses high-contrast colors for better visibility in both light and dark modes
 */
export function getRiskColor(level: string): string {
  switch (level) {
    case 'low':
      return 'text-green-800 bg-green-100 dark:text-green-100 dark:bg-green-800 border-2 border-green-600 dark:border-green-400';
    case 'medium':
      return 'text-yellow-800 bg-yellow-100 dark:text-yellow-100 dark:bg-yellow-700 border-2 border-yellow-600 dark:border-yellow-400';
    case 'high':
      return 'text-orange-800 bg-orange-100 dark:text-orange-100 dark:bg-orange-700 border-2 border-orange-600 dark:border-orange-400';
    case 'critical':
      return 'text-red-800 bg-red-100 dark:text-red-100 dark:bg-red-800 border-2 border-red-600 dark:border-red-400';
    default:
      return 'text-slate-800 bg-slate-100 dark:text-slate-100 dark:bg-slate-700 border-2 border-slate-500 dark:border-slate-400';
  }
}

/**
 * Parse schema.table string
 */
export function parseTablePath(path: string): { schema: string; table: string } {
  const parts = path.split('.');
  if (parts.length === 2) {
    return { schema: parts[0], table: parts[1] };
  }
  return { schema: 'public', table: parts[0] };
}
