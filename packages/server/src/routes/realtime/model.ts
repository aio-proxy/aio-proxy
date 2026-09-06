export const CODEX_REALTIME_MODEL = 'gpt-live-1-codex';

/** Same ceiling as `REALTIME_CALL_ID_PATTERN`'s `{1,128}`, so the module has one length
 *  bound rather than two. It is enforced where a caller-supplied model *enters* — the
 *  create body's `model`/`session.model` and `/v1/realtime`'s `model` query — because
 *  every consumer downstream of those two points (the call record, the upstream body
 *  rewrite, and all four realtime log sites) is then bounded by construction. Enforcing
 *  it at the log boundary instead would have to be repeated at every emit site, and one
 *  missed site is the whole defect this bound exists to close. */
export const MAX_REALTIME_MODEL_LENGTH = 128;

/** Mirrors the reference's `codexRealtimeModel`. Applies to **selection** only:
 *  signaling rewrites the upstream model field, while a direct WebSocket sends the
 *  originally requested id.
 *
 *  Deliberately not length-bounded: it is a pure mapping, and a *truncating* bound here
 *  could turn an over-long id into a prefix that matches a different model a provider
 *  does advertise, routing the call somewhere the caller never asked for. The bound is a
 *  rejection at the parse boundaries above instead. */
export function normalizeRealtimeModel(requested: string | undefined): string {
  const model = requested?.trim() ?? '';
  if (model.length === 0) return CODEX_REALTIME_MODEL;
  if (model === 'gpt-realtime' || model.startsWith('gpt-realtime-')) return CODEX_REALTIME_MODEL;
  if (model.includes('realtime-preview')) return CODEX_REALTIME_MODEL;
  return model;
}
