import type { DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import { buildRoutingBoard } from './routing-board';
import { applyRoutingWeight, moveRoutingProvider } from './routing-board-move';

const routingNumber = (effective: number) => ({ effective, wasNormalized: false });

const provider = (id: string): DashboardRoutingProvider => ({
  id,
  kind: ProviderKind.Api,
  enabled: true,
  state: { status: 'ready' },
  defaults: { priority: routingNumber(0), weight: routingNumber(1) },
  effective: {
    priority: 0,
    weight: 1,
    prioritySource: 'provider',
    weightSource: 'provider',
    eligible: true,
    share: 0.5,
  },
});

const providers = [provider('a'), provider('b')];
const rows = [{ providerId: 'a' }, { providerId: 'b' }];

test('moving a Provider to a new tier puts it below every existing tier', () => {
  const next = moveRoutingProvider({
    providers,
    rows,
    board: buildRoutingBoard(providers, rows),
    providerId: 'b',
    target: { type: 'new-tier' },
  });
  const tiers = buildRoutingBoard(providers, next).tiers;

  expect(tiers.map((tier) => tier.items.map((item) => item.providerId))).toEqual([['a'], ['b']]);
});

test('removing a Provider from the route parks it at weight 0 for this model', () => {
  const next = moveRoutingProvider({
    providers,
    rows,
    board: buildRoutingBoard(providers, rows),
    providerId: 'b',
    target: { type: 'unused' },
  });
  const board = buildRoutingBoard(providers, next);

  expect(board.unused.map((item) => item.providerId)).toEqual(['b']);
  expect(board.tiers.flatMap((tier) => tier.items.map((item) => item.providerId))).toEqual(['a']);
});

test('a typed weight equal to the Provider default drops the override instead of pinning it', () => {
  // Pinning the default would keep the model on today's value after the Provider default changes.
  expect(applyRoutingWeight({ providers, rows: [{ providerId: 'a', weight: 5 }], providerId: 'a', weight: 1 })).toEqual(
    [{ providerId: 'a' }],
  );
  expect(applyRoutingWeight({ providers, rows, providerId: 'a', weight: 3.4 })).toEqual([
    { providerId: 'a', weight: 3 },
    { providerId: 'b' },
  ]);
});
