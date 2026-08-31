import { isPlainObject } from 'es-toolkit/predicate';

const ANTHROPIC_FAST_MODE_BETA = 'fast-mode-2026-02-01';

export function requestAsksFastMode(body: unknown, headers: Headers): boolean {
  if (headers.get('anthropic-beta')?.includes(ANTHROPIC_FAST_MODE_BETA) === true) return true;
  if (!isPlainObject(body)) return false;
  return field(body.service_tier) === 'priority' || field(body.speed) === 'fast';
}

function field(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}
