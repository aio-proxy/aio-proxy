import type { DashboardRoutingModel } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import {
  mergeRoutingMutationDrafts,
  reconcileRoutingMetadataValues,
  routingMetadataFormValues,
} from './routing-metadata-draft';

const number = (effective: number) => ({ effective, wasNormalized: false });

const model = (): DashboardRoutingModel => ({
  modelId: 'gpt-5',
  metadata: { name: 'Stored' },
  revision: 'rev-1',
  baselineProviderIds: ['a', 'b'],
  providerCount: 2,
  eligibleProviderCount: 2,
  hasOverrides: true,
  tiers: [],
  providers: [
    {
      id: 'a',
      kind: ProviderKind.Api,
      enabled: true,
      state: { status: 'ready' },
      defaults: { priority: number(0), weight: number(1) },
      override: { cost: { input: 3 } },
      effective: {
        priority: 0,
        weight: 1,
        prioritySource: 'provider',
        weightSource: 'provider',
        eligible: true,
        share: 0.5,
      },
    },
    {
      id: 'b',
      kind: ProviderKind.Api,
      enabled: true,
      state: { status: 'ready' },
      defaults: { priority: number(0), weight: number(1) },
      effective: {
        priority: 0,
        weight: 1,
        prioritySource: 'provider',
        weightSource: 'provider',
        eligible: true,
        share: 0.5,
      },
    },
  ],
});

test('a cost edit on a Provider with no routing override still gains a body entry', () => {
  const values = routingMetadataFormValues(model());
  const merged = mergeRoutingMutationDrafts(
    {},
    {
      ...values,
      overrides: {
        ...values.overrides,
        b: { cost: { touched: true, value: { input: 0.5 } }, limit: { touched: false, value: undefined } },
      },
    },
  );

  // No metadata key (untouched); `a` still gets an empty patch so the server preserves stored metadata.
  expect('metadata' in merged).toBe(false);
  expect(merged.providers).toEqual({ a: {}, b: { cost: { input: 0.5 } } });
});

test('reconcile after a stale reload re-seeds untouched drafts and keeps touched ones', () => {
  const values = routingMetadataFormValues(model());
  const edited = {
    metadata: { touched: true, value: { name: 'Mine' } },
    overrides: {
      ...values.overrides,
      a: { cost: { touched: true, value: { input: 9 } }, limit: { touched: false, value: undefined } },
    },
  };
  const reloaded: DashboardRoutingModel = {
    ...model(),
    metadata: { name: 'Server' },
    providers: model().providers.map((provider) =>
      provider.id === 'a' ? { ...provider, override: { cost: { input: 4 }, limit: { context: 1000 } } } : provider,
    ),
  };

  const next = reconcileRoutingMetadataValues(edited, reloaded);

  expect(next.metadata).toEqual({ touched: true, value: { name: 'Mine' } });
  expect(next.overrides['a']?.cost).toEqual({ touched: true, value: { input: 9 } });
  // The untouched limit picks up the freshly stored server value.
  expect(next.overrides['a']?.limit).toEqual({ touched: false, value: { context: 1000 } });
});
