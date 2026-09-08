import type { Logger } from '@aio-proxy/plugin-sdk';

type Phase =
  | 'run-start'
  | 'first-frame'
  | 'first-text'
  | 'tool-ready'
  | 'tool-handoff'
  | 'query-reply'
  | 'turn-ended'
  | 'connect-end'
  | 'http-eof'
  | 'settled';
type Fields = {
  elapsedMs?: number;
  frameCount?: number;
  openToolCount?: number;
  readyToolCount?: number;
  queryCase?: string;
  queryId?: number;
  termination?: string;
  lastInboundAgeMs?: number;
  lastProgressAgeMs?: number;
};
const safeLabel = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

export function createRunDiagnostics(
  logger: Logger | undefined,
  context: {
    requestId: string;
    providerId?: string;
    modelId: string;
    resumeMode: 'fresh' | 'checkpoint' | 'tool-results';
  },
) {
  const base: Record<string, unknown> = {
    requestId: safeLabel(context.requestId) ?? crypto.randomUUID(),
    modelId: safeLabel(context.modelId) ?? 'unknown',
    resumeMode: context.resumeMode,
  };
  const providerId = safeLabel(context.providerId);
  if (providerId !== undefined) base['providerId'] = providerId;
  return (phase: Phase, fields: Fields = {}, failed = false): void => {
    if (logger === undefined) return;
    const props: Record<string, unknown> = { ...base, phase };
    for (const key of [
      'elapsedMs',
      'frameCount',
      'openToolCount',
      'readyToolCount',
      'queryId',
      'lastInboundAgeMs',
      'lastProgressAgeMs',
    ] as const) {
      const value = fields[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) props[key] = value;
    }
    for (const key of ['queryCase', 'termination'] as const) {
      const value = safeLabel(fields[key]);
      if (value !== undefined) props[key] = value;
    }
    try {
      if (failed) logger.warn('Cursor Run phase', props);
      else logger.debug('Cursor Run phase', props);
    } catch {
      // Logging must not change the stream or terminal result.
    }
  };
}
