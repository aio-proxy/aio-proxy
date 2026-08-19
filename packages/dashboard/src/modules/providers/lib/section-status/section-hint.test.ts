import { m } from '@aio-proxy/i18n';
import { expect, test } from '@rstest/core';

import { advancedHint, modelsHint, routingHint } from './section-hint';
import { sectionStatuses, type SectionStatusInput } from './section-status';

const base: SectionStatusInput = {
  kind: 'api',
  mode: 'create',
  id: 'p1',
  baseURL: 'https://x.example/v1',
  protocol: 'openai-compatible',
  apiKey: 'sk-test',
  models: ['m1'],
  aliasIssues: [],
  transformsValid: true,
  weightTie: false,
};

// One plural-only key per noun rendered "1 models", "1 aliases", "1 headers", "1 rewrites". The
// assertions are en literals on purpose: ja/ko/zh have no plural inflection, so their singular and
// plural values are identical and a key-to-key comparison would pass against the plural-only mutant.
test('a hint with a count of one reads singular in en', () => {
  expect(modelsHint({ ...base, models: ['only'], aliasCount: 1 }, 'ok')).toBe('1 model · 1 alias');
  expect(advancedHint({ ...base, headerCount: 1, transformCount: 1 }, 'ok')).toBe('1 header · 1 rewrite');
});

// The mirror mutant: hardcoding the singular key would break every other count.
test('a hint with any other count stays plural in en', () => {
  expect(modelsHint({ ...base, models: ['a', 'b'], aliasCount: 2 }, 'ok')).toBe('2 models · 2 aliases');
  expect(advancedHint({ ...base, headerCount: 2, transformCount: 3 }, 'ok')).toBe('2 headers · 3 rewrites');
});

// An oauth provider's empty whitelist means "expose the whole upstream catalog" (section-status.ts:61-67),
// and `sectionStatuses` calls that `ok`. Counting the unfetched catalog printed "0 models" — the exact
// opposite of the real exposure — so the count is not the honest readout there.
test('an oauth provider exposing its whole catalog never reads as a count of zero', () => {
  const summaries = sectionStatuses({ ...base, kind: 'oauth', capabilityKey: 'p\0c', authorized: true, models: [] });

  expect(summaries.models.status).toBe('ok');
  expect(summaries.models.hint).toBe(m['dashboard.providers.editor.hint_models_all']());
  // Aliases still get their own segment; the exposure phrase replaces the count, not the whole hint.
  expect(modelsHint({ ...base, kind: 'oauth', models: [], aliasCount: 1 }, 'ok')).toBe('All upstream models · 1 alias');
});

// Widening the exemption past oauth is the tempting over-fix: `modelRoutes` derives an api provider's
// routes from its whitelist plus its alias map, so an empty whitelist there really does route no direct
// models and "0 models" is true.
test('a non-oauth provider with an empty whitelist still reads as zero models', () => {
  expect(modelsHint({ ...base, models: [], aliasCount: 1 }, 'ok')).toBe('0 models · 1 alias');
});

// `0` is a real configured weight and absent is the key being omitted from config; the routing badge
// coalesced the two while the attempt-order queue beside it renders a dash for absent, so one screen
// stated both. Ordering still coalesces to 0 (attempt-order-preview's `effectiveWeight`) — this is the
// readout only.
test('the routing hint tells an absent weight apart from a configured zero', () => {
  const input = { ...base, models: ['m1'], aliasCount: 0 } satisfies SectionStatusInput;

  expect(routingHint({ ...input, weight: 0 }, 'ok')).toBe(
    m['dashboard.providers.editor.hint_routing_weight']({ weight: 0 }),
  );
  expect(routingHint(input, 'ok')).toBe(m['dashboard.providers.editor.hint_routing_no_weight']());
  expect(routingHint(input, 'ok')).not.toBe(m['dashboard.providers.editor.hint_routing_weight']({ weight: 0 }));
});
