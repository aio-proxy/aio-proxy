import { cn } from '@aio-proxy/ui/lib/utils';

export type LatencyGrade = 'success' | 'warning' | 'danger';

export const firstResponseTimeGrade = (milliseconds: number): LatencyGrade => {
  const seconds = milliseconds / 1_000;
  if (seconds < 5) return 'success';
  if (seconds < 10) return 'warning';
  return 'danger';
};

export const responseTimeGrade = (milliseconds: number, outputTokens = 0): LatencyGrade => {
  const seconds = milliseconds / 1_000;
  if (outputTokens < 100 || seconds <= 0) return timeGrade(seconds);
  return throughputGrade(outputTokens / seconds);
};

export const latencyDotClassName = (grade: LatencyGrade): string =>
  cn(
    'size-1.5 rounded-full',
    grade === 'success' ? 'bg-primary' : grade === 'warning' ? 'bg-amber-600 dark:bg-amber-400' : 'bg-destructive',
  );

const timeGrade = (seconds: number): LatencyGrade => {
  if (seconds < 10) return 'success';
  if (seconds < 30) return 'warning';
  return 'danger';
};

const throughputGrade = (tokensPerSecond: number): LatencyGrade => {
  if (tokensPerSecond >= 30) return 'success';
  if (tokensPerSecond >= 15) return 'warning';
  return 'danger';
};
