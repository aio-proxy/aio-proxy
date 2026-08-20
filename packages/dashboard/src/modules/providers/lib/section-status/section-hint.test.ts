import { m } from '@aio-proxy/i18n';
import { expect, test } from '@rstest/core';

import { advancedHint, connectionHint, modelsHint, routingHint } from './section-hint';
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

// The alias editor moved into Models (D-F6), so the badge that blocks the save has to name the alias
// rather than the exposure count it would otherwise print beside a save-blocking dot.
test('the models hint names a broken alias ahead of anything it counts', () => {
  const aliasIssues = [{ code: 'target-missing' as const, alias: 'smart' }];

  expect(modelsHint({ ...base, models: ['m1'], aliasCount: 1, aliasIssues }, 'todo')).toBe(
    m['dashboard.providers.editor.hint_models_alias_issues'](),
  );
  // Also ahead of the stale-catalog text, which describes a different, non-blocking problem. Both
  // conditions hold here, so this pins the order rather than either branch alone.
  expect(modelsHint({ ...base, models: ['m1'], discoveredModels: ['other'], aliasIssues }, 'todo')).toBe(
    m['dashboard.providers.editor.hint_models_alias_issues'](),
  );
});

// X9 downgraded staleness and a weight tie from `attention` to `ok`. Both hints used to be selected BY
// `status === 'attention'`, so the downgrade would have silently deleted both explanations; each now
// reads its own input. One assertion per hint, with the status the section actually reports now — pass
// `'attention'` and these pass against the deleted branch.
test('the two downgraded conditions still explain themselves at status ok', () => {
  expect(modelsHint({ ...base, models: ['gone'], discoveredModels: ['here'] }, 'ok')).toBe(
    m['dashboard.providers.editor.hint_models_stale'](),
  );
  expect(routingHint({ ...base, weightTie: true })).toBe(m['dashboard.providers.editor.hint_routing_weight_tie']());
  // The mirror half: neither may fire when its own condition is absent, or every healthy section reports
  // a problem it does not have.
  expect(modelsHint({ ...base, models: ['m1'], discoveredModels: ['m1'] }, 'ok')).toBe('1 model');
  expect(routingHint(base)).toBe(m['dashboard.providers.editor.hint_routing_no_weight']());
});

// C15 (ruled 2026-08-19): a provider with no api key is a legitimate configuration, so the badge keeps
// showing the address instead of calling the blank field out. Asserted in both modes because create mode
// used to be the one that differed.
test('a blank api key leaves the badge on the address, in either mode', () => {
  expect(connectionHint({ ...base, apiKey: '' }, 'ok')).toBe('x.example/v1');
  expect(connectionHint({ ...base, apiKey: '', mode: 'edit' }, 'ok')).toBe('x.example/v1');
});

// S2 made "present but unusable" a second way for Connection to be `todo`, and the one hint the badge
// had said "Needs a protocol and address" — so a user who had typed an address was told it was missing.
test('a malformed base URL says the address is invalid, not that it is missing', () => {
  const badHint = m['dashboard.providers.editor.hint_connection_bad_base_url']();

  // Unparseable, and the parseable-but-not-http(s) case the gate also rejects (D-F12). The copy has to
  // be true of both, so both assert the same key.
  expect(sectionStatuses({ ...base, baseURL: 'api.example.com' }).connection.hint).toBe(badHint);
  expect(sectionStatuses({ ...base, baseURL: 'ftp://x.example' }).connection.hint).toBe(badHint);
  expect(sectionStatuses({ ...base, baseURL: '{{env.OPENAI_BASE_URL}}' }).connection.hint).toBe(badHint);

  // The other direction, or the branch would just swallow the original hint: an EMPTY address keeps it,
  // because there the protocol may be the missing half too.
  expect(sectionStatuses({ ...base, baseURL: '' }).connection.hint).toBe(
    m['dashboard.providers.editor.hint_connection_todo_api'](),
  );
  // And so does a usable address whose protocol is unset — the other input that makes this section todo.
  expect(sectionStatuses({ ...base, protocol: undefined }).connection.hint).toBe(
    m['dashboard.providers.editor.hint_connection_todo_api'](),
  );
  // Keyed off the status, not off `usableBaseURL` alone: the `ok` copy is its own branch, and
  // reordering the guard above it would report a bad address on a section that has none.
  expect(sectionStatuses(base).connection.hint).toBe('x.example/v1');
});

// `0` is a real configured weight and absent is the key being omitted from config; the routing badge
// coalesced the two, so a provider that was never given a weight read as one deliberately set to zero.
// Ordering still coalesces to 0 (config.ts:185, the single ordering point, mirrored by `lib/weight-tie`'s
// `effectiveWeight`) — this is the readout only.
test('the routing hint tells an absent weight apart from a configured zero', () => {
  const input = { ...base, models: ['m1'], aliasCount: 0 } satisfies SectionStatusInput;

  expect(routingHint({ ...input, weight: 0 })).toBe(m['dashboard.providers.editor.hint_routing_weight']({ weight: 0 }));
  expect(routingHint(input)).toBe(m['dashboard.providers.editor.hint_routing_no_weight']());
  expect(routingHint(input)).not.toBe(m['dashboard.providers.editor.hint_routing_weight']({ weight: 0 }));
});
