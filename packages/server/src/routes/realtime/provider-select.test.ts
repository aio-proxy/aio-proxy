import { expect, test } from 'bun:test';

import type { RealtimeTransport } from '@aio-proxy/plugin-sdk';
import { ProviderKind } from '@aio-proxy/types';

import type { ProviderRouteSnapshot, RuntimeProviderInstance } from '../../runtime';
import { pinnedRealtimeCandidate, selectRealtimeCandidates } from './provider-select';

test('ordering is priority descending, then weight descending, then provider id', () => {
  const snapshot = snapshotOf([
    realtimeProvider({ id: 'c', priority: 1, weight: 5 }),
    realtimeProvider({ id: 'a', priority: 9, weight: 1 }),
    realtimeProvider({ id: 'b', priority: 9, weight: 4 }),
    realtimeProvider({ id: 'd', priority: 9, weight: 4 }),
  ]);

  const ordered = selectRealtimeCandidates(snapshot, {
    requested: 'gpt-realtime',
    normalized: 'gpt-live-1-codex',
  });

  expect(ordered.map((candidate) => candidate.provider.id)).toEqual(['b', 'd', 'a', 'c']);
});

test('ineligible providers are skipped', () => {
  const snapshot = snapshotOf([
    realtimeProvider({ id: 'disabled', enabled: false }),
    realtimeProvider({ id: 'zero-weight', weight: 0 }),
    realtimeProvider({ id: 'rounds-to-zero', weight: 0.4 }),
    realtimeProvider({ id: 'wrong-model', models: ['gpt-audio'] }),
    { ...realtimeProvider({ id: 'no-realtime' }), realtime: undefined },
    realtimeProvider({ id: 'eligible' }),
  ]);

  const ordered = selectRealtimeCandidates(snapshot, {
    requested: 'gpt-realtime',
    normalized: 'gpt-live-1-codex',
  });

  expect(ordered.map((candidate) => candidate.provider.id)).toEqual(['eligible']);
});

test('a model override replaces the provider weight and can make a candidate ineligible', () => {
  const snapshot = snapshotOf([realtimeProvider({ id: 'codex', weight: 7 })], {
    'gpt-live-1-codex': { providers: { codex: { weight: 0 } } },
  });

  expect(
    selectRealtimeCandidates(snapshot, { requested: 'gpt-realtime', normalized: 'gpt-live-1-codex' }),
  ).toHaveLength(0);
});

// The routing rule is that an exact-model override replaces the provider default, and the
// weight half of that was already honored here while the priority half was not. Two ChatGPT
// accounts were therefore attempted in the wrong failover tier: with at most two create
// attempts, the tier order decides which account serves the call.
test('a model override replaces the provider priority and reorders the failover tiers', () => {
  const snapshot = snapshotOf(
    [realtimeProvider({ id: 'low', priority: 1 }), realtimeProvider({ id: 'high', priority: 9 })],
    {
      'gpt-live-1-codex': { providers: { low: { priority: 50 } } },
    },
  );

  const ordered = selectRealtimeCandidates(snapshot, { requested: 'gpt-realtime', normalized: 'gpt-live-1-codex' });

  // Without the override `high` (9) leads; the override lifts `low` to tier 50.
  expect(ordered.map((candidate) => candidate.provider.id)).toEqual(['low', 'high']);
  expect(ordered.map((candidate) => candidate.priority)).toEqual([50, 9]);
});

// A wholesale replacement, not a maximum: an override *below* the authored priority has to
// demote the provider. A `Math.max(authored, override)` would satisfy the test above.
test('a model priority override lower than the authored priority demotes the provider', () => {
  const snapshot = snapshotOf(
    [realtimeProvider({ id: 'demoted', priority: 9 }), realtimeProvider({ id: 'plain', priority: 5 })],
    {
      'gpt-live-1-codex': { providers: { demoted: { priority: 1 } } },
    },
  );

  const ordered = selectRealtimeCandidates(snapshot, { requested: 'gpt-realtime', normalized: 'gpt-live-1-codex' });

  expect(ordered.map((candidate) => candidate.provider.id)).toEqual(['plain', 'demoted']);
});

// A priority override of 0 is a real tier, not an absent value: `??` keeps it while `||`
// would silently fall back to the authored 9 and leave the provider in the top tier.
test('a model priority override of zero is honored rather than treated as absent', () => {
  const snapshot = snapshotOf(
    [realtimeProvider({ id: 'zeroed', priority: 9 }), realtimeProvider({ id: 'plain', priority: 1 })],
    {
      'gpt-live-1-codex': { providers: { zeroed: { priority: 0 } } },
    },
  );

  const ordered = selectRealtimeCandidates(snapshot, { requested: 'gpt-realtime', normalized: 'gpt-live-1-codex' });

  expect(ordered.map((candidate) => candidate.provider.id)).toEqual(['plain', 'zeroed']);
  expect(ordered.map((candidate) => candidate.priority)).toEqual([1, 0]);
});

// An override keyed on a model this request is not for must not bleed across. Selection
// matches on the normalized id, so the override for `gpt-realtime` is not this request's.
test('a priority override for a different model does not affect this selection', () => {
  const snapshot = snapshotOf(
    [realtimeProvider({ id: 'low', priority: 1 }), realtimeProvider({ id: 'high', priority: 9 })],
    {
      'gpt-realtime': { providers: { low: { priority: 50 } } },
    },
  );

  const ordered = selectRealtimeCandidates(snapshot, { requested: 'gpt-realtime', normalized: 'gpt-live-1-codex' });

  expect(ordered.map((candidate) => candidate.provider.id)).toEqual(['high', 'low']);
});

test('an effective weight above the routing maximum is clamped rather than sorted ahead', () => {
  const snapshot = snapshotOf([
    realtimeProvider({ id: 'clamped', weight: 99_999 }),
    realtimeProvider({ id: 'ceiling', weight: 10_000 }),
  ]);

  const ordered = selectRealtimeCandidates(snapshot, {
    requested: 'gpt-realtime',
    normalized: 'gpt-live-1-codex',
  });

  expect(ordered.map((candidate) => candidate.weight)).toEqual([10_000, 10_000]);
  expect(ordered.map((candidate) => candidate.provider.id)).toEqual(['ceiling', 'clamped']);
});

test('exclusion matches on both the requested and the normalized model id', () => {
  const provider = realtimeProvider({ id: 'codex' });
  const excludedRequested = snapshotOf([provider], {}, [{ id: 'codex', excludedModels: ['gpt-realtime'] }]);
  const excludedNormalized = snapshotOf([provider], {}, [{ id: 'codex', excludedModels: ['gpt-live-1-codex'] }]);
  const models = { requested: 'gpt-realtime', normalized: 'gpt-live-1-codex' };

  expect(selectRealtimeCandidates(excludedRequested, models)).toHaveLength(0);
  expect(selectRealtimeCandidates(excludedNormalized, models)).toHaveLength(0);
  // Exclusions live in config, so a snapshot without config excludes nothing.
  expect(selectRealtimeCandidates(snapshotOf([provider]), models)).toHaveLength(1);
});

test('a pin resolves only when the provider id, account, and runtime revision all still match', () => {
  const snapshot = snapshotOf([realtimeProvider({ id: 'codex' })]);
  const pin = { providerId: 'codex', accountId: 'person@example.com', runtimeRevision: 3 };

  expect(pinnedRealtimeCandidate(snapshot, pin)?.provider.id).toBe('codex');
  expect(pinnedRealtimeCandidate(snapshot, { ...pin, runtimeRevision: 4 })).toBeUndefined();
  expect(pinnedRealtimeCandidate(snapshot, { ...pin, accountId: 'other@example.com' })).toBeUndefined();
  expect(pinnedRealtimeCandidate(snapshot, { ...pin, providerId: 'missing' })).toBeUndefined();
});

test('a pin to a now-disabled provider does not resolve', () => {
  const snapshot = snapshotOf([realtimeProvider({ id: 'codex', enabled: false })]);

  expect(
    pinnedRealtimeCandidate(snapshot, {
      providerId: 'codex',
      accountId: 'person@example.com',
      runtimeRevision: 3,
    }),
  ).toBeUndefined();
});

// A plugin whose realtime materialization failed yields an instance whose
// `accountId` and `runtimeRevision` still satisfy the pin while `realtime` is gone.
// Without the transport check the route would hand `undefined.fetch` to the sideband.
test('a pin to a provider that lost its realtime transport does not resolve', () => {
  const snapshot = snapshotOf([{ ...realtimeProvider({ id: 'codex' }), realtime: undefined }]);

  expect(
    pinnedRealtimeCandidate(snapshot, {
      providerId: 'codex',
      accountId: 'person@example.com',
      runtimeRevision: 3,
    }),
  ).toBeUndefined();
});

const transport: RealtimeTransport = {
  models: ['gpt-live-1-codex'],
  fetch: () => Promise.resolve(new Response(null, { status: 204 })),
  dial: () => Promise.reject(new Error('not dialed in this test')),
};

function realtimeProvider(overrides: {
  readonly id: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly weight?: number;
  readonly models?: readonly string[];
}): RuntimeProviderInstance {
  const { id, models, ...routing } = overrides;
  return {
    id,
    kind: ProviderKind.OAuth,
    enabled: routing.enabled ?? true,
    priority: routing.priority ?? 0,
    weight: routing.weight ?? 1,
    accountId: 'person@example.com',
    runtimeRevision: 3,
    capabilityIndex: {},
    models: ['gpt-5.5'],
    raw: { resolve: () => undefined },
    realtime: { ...transport, models: [...(models ?? ['gpt-live-1-codex'])] },
  } as unknown as RuntimeProviderInstance;
}

function snapshotOf(
  providers: readonly RuntimeProviderInstance[],
  models: Record<
    string,
    { readonly providers: Record<string, { readonly weight?: number; readonly priority?: number }> }
  > = {},
  configProviders: readonly { readonly id: string; readonly excludedModels?: readonly string[] }[] = [],
): ProviderRouteSnapshot {
  return {
    providers,
    config: { router: { models }, providers: configProviders },
  } as unknown as ProviderRouteSnapshot;
}
