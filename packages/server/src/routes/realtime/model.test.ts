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

test('an unrelated model id passes through so a future realtime provider can serve it', () => {
  expect(normalizeRealtimeModel('gpt-live-1-codex')).toBe('gpt-live-1-codex');
  expect(normalizeRealtimeModel('some-other-live-model')).toBe('some-other-live-model');
});
