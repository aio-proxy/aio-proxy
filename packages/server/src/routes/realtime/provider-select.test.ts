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
  models: Record<string, { readonly providers: Record<string, { readonly weight?: number }> }> = {},
  configProviders: readonly { readonly id: string; readonly excludedModels?: readonly string[] }[] = [],
): ProviderRouteSnapshot {
  return {
    providers,
    config: { router: { models }, providers: configProviders },
  } as unknown as ProviderRouteSnapshot;
}
