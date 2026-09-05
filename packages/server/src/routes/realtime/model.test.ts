import { expect, test } from 'bun:test';

import { CODEX_REALTIME_MODEL, normalizeRealtimeModel } from './model';

test('every realtime alias the client may send normalizes to the Codex realtime model', () => {
  for (const requested of [
    undefined,
    '',
    'gpt-realtime',
    'gpt-realtime-2026-01-01',
    'gpt-4o-realtime-preview',
    'gpt-4o-mini-realtime-preview-2024-12-17',
  ]) {
    expect(normalizeRealtimeModel(requested)).toBe(CODEX_REALTIME_MODEL);
  }
});

// Asserted as a literal, not against the constant, because the literal *is* the
// contract: it must equal what the Codex transport advertises
// (`CODEX_REALTIME_MODELS` in packages/plugins/openai-chatgpt/src/runtime/realtime.ts,
// pinned by the same literal in that package's realtime test). Selection matches with
// `realtime.models.includes(models.normalized)`, so drift on either side leaves every
// realtime request with no candidate provider.
test('the canonical realtime model id is the literal the Codex transport advertises', () => {
  expect(CODEX_REALTIME_MODEL).toBe('gpt-live-1-codex');
});

test('an unrelated model id passes through so a future realtime provider can serve it', () => {
  expect(normalizeRealtimeModel('gpt-live-1-codex')).toBe('gpt-live-1-codex');
  expect(normalizeRealtimeModel('some-other-live-model')).toBe('some-other-live-model');
});
