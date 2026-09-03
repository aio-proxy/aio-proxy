import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import { providerStub } from '../provider-fixtures';
import { canEditProvider, emptyProviderListFilters, providerDisplayName, visibleProviders } from './provider-list-view';

test('prefers the configured name, then the account label, then the Provider ID', () => {
  expect(providerDisplayName(providerStub({ id: 'kimi', name: 'Kimi', accountLabel: 'a@b.com' }))).toBe('Kimi');
  expect(providerDisplayName(providerStub({ id: 'kimi', accountLabel: 'a@b.com' }))).toBe('a@b.com');
  expect(providerDisplayName(providerStub({ id: 'kimi' }))).toBe('kimi');
});

test('a configuration-invalid Provider is not editable', () => {
  expect(canEditProvider(providerStub({ kind: 'invalid' }))).toBe(false);
  expect(
    canEditProvider(
      providerStub({
        state: {
          status: 'unavailable',
          diagnostic: {
            code: 'PROVIDER_CONFIG_INVALID',
            summary: 'bad',
            retryable: false,
            occurredAt: '2026-09-01T00:00:00.000Z',
          },
        },
      }),
    ),
  ).toBe(false);
  expect(
    canEditProvider(
      providerStub({
        state: {
          status: 'unavailable',
          diagnostic: {
            code: 'CREDENTIALS_MISSING_OR_INVALID',
            summary: 'x',
            retryable: false,
            occurredAt: '2026-09-01T00:00:00.000Z',
          },
        },
      }),
    ),
  ).toBe(true);
});

test('search matches the display name and the Provider ID, case-insensitively', () => {
  const providers = [providerStub({ id: 'alpha-one', name: 'Carpool' }), providerStub({ id: 'beta', name: 'Zebra' })];
  expect(visibleProviders(providers, { ...emptyProviderListFilters, search: 'CARPO' }).map((p) => p.id)).toEqual([
    'alpha-one',
  ]);
  expect(visibleProviders(providers, { ...emptyProviderListFilters, search: 'BETA' }).map((p) => p.id)).toEqual([
    'beta',
  ]);
});

test('chips narrow by availability, enablement, and kind', () => {
  const providers = [
    providerStub({ id: 'ok', kind: ProviderKind.OAuth, enabled: true }),
    providerStub({ id: 'off', kind: ProviderKind.Api, enabled: false }),
    providerStub({
      id: 'broken',
      kind: ProviderKind.Api,
      state: {
        status: 'unavailable',
        diagnostic: {
          code: 'CATALOG_UNAVAILABLE',
          summary: 'x',
          retryable: true,
          occurredAt: '2026-09-01T00:00:00.000Z',
        },
      },
    }),
  ];
  const ids = (filters: Partial<typeof emptyProviderListFilters>) =>
    visibleProviders(providers, { ...emptyProviderListFilters, ...filters }).map((p) => p.id);

  expect(ids({ availability: 'unavailable' })).toEqual(['broken']);
  expect(ids({ enablement: 'disabled' })).toEqual(['off']);
  expect(ids({ kind: 'oauth' })).toEqual(['ok']);
});

test('sorts by priority descending, then weight descending, then Provider ID', () => {
  const providers = [
    providerStub({ id: 'c', priority: 1, weight: 5 }),
    providerStub({ id: 'a', priority: 10, weight: 1 }),
    providerStub({ id: 'b', priority: 10, weight: 9 }),
    providerStub({ id: 'd' }),
  ];
  expect(visibleProviders(providers, emptyProviderListFilters).map((p) => p.id)).toEqual(['b', 'a', 'c', 'd']);
});
