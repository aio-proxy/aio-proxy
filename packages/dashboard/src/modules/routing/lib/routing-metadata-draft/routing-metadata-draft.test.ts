import type { DashboardRoutingModel } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import {
  mergeRoutingMutationDrafts,
  reconcileRoutingMetadataValues,
  routingDirtyTabs,
  routingMetadataFormValues,
  routingMetadataTouched,
  routingOverrideDraftsValid,
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

  const next = reconcileRoutingMetadataValues(edited, reloaded, values);

  expect(next.metadata).toEqual({ touched: true, value: { name: 'Mine' } });
  expect(next.overrides['a']?.cost).toEqual({ touched: true, value: { input: 9 } });
  // The untouched limit picks up the freshly stored server value.
  expect(next.overrides['a']?.limit).toEqual({ touched: false, value: { context: 1000 } });
});

test('reconcile keeps a field another operator changed when the user edited a different one', () => {
  // The user changed only the input price; the server meanwhile renamed the model and changed the
  // output price. Replaying the whole touched object would write the stale name and output back.
  const base = routingMetadataFormValues({ ...model(), metadata: { name: 'Old', cost: { input: 1, output: 2 } } });
  const edited = { ...base, metadata: { touched: true, value: { name: 'Old', cost: { input: 3, output: 2 } } } };
  const reloaded: DashboardRoutingModel = {
    ...model(),
    metadata: { name: 'New', cost: { input: 1, output: 5 } },
  };

  const next = reconcileRoutingMetadataValues(edited, reloaded, base);

  expect(next.metadata).toEqual({ touched: true, value: { name: 'New', cost: { input: 3, output: 5 } } });
});

test('a touched limit with input above context is invalid for Save', () => {
  expect(
    routingOverrideDraftsValid({
      a: {
        cost: { touched: false, value: undefined },
        limit: { touched: true, value: { context: 100, input: 200 } },
      },
    }),
  ).toBe(false);
});

test('a touched valid or cleared limit stays valid', () => {
  expect(
    routingOverrideDraftsValid({
      a: {
        cost: { touched: true, value: { input: 1 } },
        limit: { touched: true, value: { context: 200, input: 100 } },
      },
      b: { cost: { touched: false, value: undefined }, limit: { touched: true, value: undefined } },
    }),
  ).toBe(true);
});

const metadataValues = (over: {
  readonly metadataTouched?: boolean;
  readonly costTouched?: boolean;
  readonly limitTouched?: boolean;
}) => ({
  metadata: { touched: over.metadataTouched ?? false, value: undefined },
  overrides: {
    a: {
      cost: { touched: over.costTouched ?? false, value: undefined },
      limit: { touched: over.limitTouched ?? false, value: undefined },
    },
  },
});

test('names the dirty tabs in the order the editor renders them', () => {
  // The tab markers and the navigation guard both read this, so the order is part of the contract.
  expect(routingDirtyTabs(true, metadataValues({ metadataTouched: true, costTouched: true }))).toStrictEqual([
    'topology',
    'metadata',
    'cost',
  ]);
  expect(routingDirtyTabs(false, metadataValues({}))).toStrictEqual([]);
});

test('counts a touched limit group as cost-tab work, not metadata-tab work', () => {
  // Cost and limit overrides share one tab, and neither is the metadata draft.
  expect(routingDirtyTabs(false, metadataValues({ limitTouched: true }))).toStrictEqual(['cost']);
  expect(routingDirtyTabs(false, metadataValues({ metadataTouched: true }))).toStrictEqual(['metadata']);
});

test('reports metadata work from either half of the form', () => {
  // The model-identity resync refuses to overwrite drafts, so missing either half would silently
  // discard the user's edits when a refetch brings a new revision.
  expect(routingMetadataTouched(metadataValues({}))).toBe(false);
  expect(routingMetadataTouched(metadataValues({ metadataTouched: true }))).toBe(true);
  expect(routingMetadataTouched(metadataValues({ costTouched: true }))).toBe(true);
  expect(routingMetadataTouched(metadataValues({ limitTouched: true }))).toBe(true);
});
