export const DEFAULT_POLL_MS = 60_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

export function nextBackoffMs(previous: number, pollMs: number): number {
  const base = previous <= 0 ? pollMs : Math.min(MAX_BACKOFF_MS, previous * 2);
  const jitter = Math.round(base * (0.8 + Math.random() * 0.4));
  return Math.min(MAX_BACKOFF_MS, Math.max(pollMs, jitter));
}
