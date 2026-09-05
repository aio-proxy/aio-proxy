export const CODEX_REALTIME_MODEL = 'gpt-live-1-codex';

/** Mirrors the reference's `codexRealtimeModel`. Applies to **selection** only:
 *  signaling rewrites the upstream model field, while a direct WebSocket sends the
 *  originally requested id. */
export function normalizeRealtimeModel(requested: string | undefined): string {
  const model = requested?.trim() ?? '';
  if (model.length === 0) return CODEX_REALTIME_MODEL;
  if (model === 'gpt-realtime' || model.startsWith('gpt-realtime-')) return CODEX_REALTIME_MODEL;
  if (model.includes('realtime-preview')) return CODEX_REALTIME_MODEL;
  return model;
}
