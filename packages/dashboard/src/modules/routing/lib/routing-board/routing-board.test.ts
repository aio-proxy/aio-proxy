import type { DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import type { WeightedTierLayout } from '@/lib/weighted-tier-layout';

import { applyRoutingBoardLayout, applyRoutingShare, buildRoutingBoard } from './routing-board';

const routingNumber = (effective: number, authored?: number) => ({
  ...(authored === undefined ? {} : { authored }),
  effective,
  wasNormalized: authored !== undefined && authored !== effective,
});

const provider = (
  values: Partial<DashboardRoutingProvider> & Pick<DashboardRoutingProvider, 'id'>,
): DashboardRoutingProvider => ({
  kind: ProviderKind.Api,
  enabled: true,
  state: { status: 'ready' },
  defaults: { priority: routingNumber(0), weight: routingNumber(1) },
  effective: {
    priority: values.defaults?.priority.effective ?? 0,
    weight: values.defaults?.weight.effective ?? 1,
    prioritySource: values.override?.priority === undefined ? 'provider' : 'model',
    weightSource: values.override?.weight === undefined ? 'provider' : 'model',
    eligible:
      (values.enabled ?? true) && (values.override?.weight?.effective ?? values.defaults?.weight.effective ?? 1) > 0,
    share: null,
  },
  ...values,
});

const providers = [
  provider({
    id: 'a',
    override: { priority: routingNumber(30, 30), weight: routingNumber(6000, 6000) },
    effective: {
      priority: 30,
      weight: 6000,
      prioritySource: 'model',
      weightSource: 'model',
      eligible: true,
      share: 0.6,
    },
  }),
  provider({
    id: 'b',
    defaults: { priority: routingNumber(30, 30), weight: routingNumber(4000, 4000) },
    effective: {
      priority: 30,
      weight: 4000,
      prioritySource: 'provider',
      weightSource: 'provider',
      eligible: true,
      share: 0.4,
    },
  }),
  provider({
    id: 'c',
    defaults: { priority: routingNumber(20), weight: routingNumber(1000) },
    override: { weight: routingNumber(0, 0) },
    effective: {
      priority: 20,
      weight: 0,
      prioritySource: 'provider',
      weightSource: 'model',
      eligible: false,
      share: null,
    },
  }),
];

const rows = [{ providerId: 'a', priority: 30, weight: 6000 }, { providerId: 'b' }, { providerId: 'c', weight: 0 }];

const tierProvider = (id: string, priority: number, weight: number): DashboardRoutingProvider =>
  provider({
    id,
    override: { priority: routingNumber(priority, priority), weight: routingNumber(weight, weight) },
    effective: {
      priority,
      weight,
      prioritySource: 'model',
      weightSource: 'model',
      eligible: true,
      share: 1,
    },
  });

test('groups eligible Providers by priority and parks zero-weight ones as unused', () => {
  const board = buildRoutingBoard(providers, rows);
  expect(board.tiers).toEqual([
    {
      priority: 30,
      items: [
        { providerId: 'a', draggable: true, share: 0.6, weight: 6000 },
        { providerId: 'b', draggable: true, share: 0.4, weight: 4000 },
      ],
    },
  ]);
  expect(board.unused).toEqual([{ providerId: 'c', draggable: true, share: null, weight: 0 }]);
});

test('keeps weights when only the order inside a tier changes', () => {
  const previousLayout = {
    tiers: [{ id: 'tier:30', itemIds: ['a', 'b'] }],
    parking: { unused: ['c'] },
  } satisfies WeightedTierLayout;
  expect(
    applyRoutingBoardLayout({
      providers,
      previousRows: rows,
      previousLayout,
      nextLayout: { ...previousLayout, tiers: [{ id: 'tier:30', itemIds: ['b', 'a'] }] },
      operation: { type: 'item', id: 'a' },
    }),
  ).toEqual(rows);
});

test('share slider scales a 1/1 split up so a drag can change the ratio', () => {
  expect(
    applyRoutingShare({
      providers: [
        provider({ id: 'a' }),
        provider({ id: 'b' }),
        provider({
          id: 'c',
          defaults: { priority: routingNumber(20), weight: routingNumber(1000) },
          override: { weight: routingNumber(0, 0) },
        }),
      ],
      rows: [{ providerId: 'a' }, { providerId: 'b' }, { providerId: 'c', weight: 0 }],
      memberIds: ['a', 'b'],
      providerId: 'a',
      weight: 7000,
    }),
  ).toEqual([
    { providerId: 'a', weight: 7000 },
    { providerId: 'b', weight: 3000 },
    { providerId: 'c', weight: 0 },
  ]);
});

test('share slider keeps sibling ratios while changing one Provider percent', () => {
  expect(
    applyRoutingShare({
      providers,
      rows,
      memberIds: ['a', 'b'],
      providerId: 'a',
      weight: 7000,
    }),
  ).toEqual([
    { providerId: 'a', priority: 30, weight: 7000 },
    { providerId: 'b', weight: 3000 },
    { providerId: 'c', weight: 0 },
  ]);
});

test('dropping below a tier creates a lower priority and keeps weight', () => {
  const previousLayout = {
    tiers: [{ id: 'tier:30', itemIds: ['a', 'b'] }],
    parking: { unused: ['c'] },
  } satisfies WeightedTierLayout;
  expect(
    applyRoutingBoardLayout({
      providers,
      previousRows: rows,
      previousLayout,
      nextLayout: {
        tiers: [
          { id: 'tier:30', itemIds: ['b'] },
          { id: 'tier:new:1', itemIds: ['a'] },
        ],
        parking: previousLayout.parking,
      },
      operation: { type: 'item', id: 'a' },
    }),
  ).toEqual([{ providerId: 'a', priority: 20, weight: 6000 }, { providerId: 'b' }, { providerId: 'c', weight: 0 }]);
});

test('normalized item movement disables and restores a Provider through unused', () => {
  const previousLayout = {
    tiers: [{ id: 'tier:30', itemIds: ['a', 'b'] }],
    parking: { unused: ['c'] },
  } satisfies WeightedTierLayout;
  const disabledLayout = {
    tiers: [{ id: 'tier:30', itemIds: ['b'] }],
    parking: { unused: ['c', 'a'] },
  } satisfies WeightedTierLayout;
  const disabled = applyRoutingBoardLayout({
    providers,
    previousRows: rows,
    previousLayout,
    nextLayout: disabledLayout,
    operation: { type: 'item', id: 'a' },
  });
  expect(disabled).toEqual([
    { providerId: 'a', priority: 30, weight: 0 },
    { providerId: 'b' },
    { providerId: 'c', weight: 0 },
  ]);

  expect(
    applyRoutingBoardLayout({
      providers,
      previousRows: disabled,
      previousLayout: disabledLayout,
      nextLayout: previousLayout,
      operation: { type: 'item', id: 'a' },
    }),
  ).toEqual([{ providerId: 'a', priority: 30 }, { providerId: 'b' }, { providerId: 'c', weight: 0 }]);
});

test('new highest slot allocates an open priority', () => {
  const previousLayout = {
    tiers: [{ id: 'tier:30', itemIds: ['a', 'b'] }],
    parking: { unused: ['c'] },
  } satisfies WeightedTierLayout;
  expect(
    applyRoutingBoardLayout({
      providers,
      previousRows: rows,
      previousLayout,
      nextLayout: {
        tiers: [
          { id: 'tier:new:1', itemIds: ['a'] },
          { id: 'tier:30', itemIds: ['b'] },
        ],
        parking: previousLayout.parking,
      },
      operation: { type: 'item', id: 'a' },
    }),
  ).toEqual([{ providerId: 'a', priority: 40, weight: 6000 }, { providerId: 'b' }, { providerId: 'c', weight: 0 }]);
});

test('compacts priorities when neighboring tiers have no integer gap', () => {
  const tight = [
    provider({
      id: 'a',
      override: { priority: routingNumber(2, 2), weight: routingNumber(1, 1) },
    }),
    provider({
      id: 'b',
      override: { priority: routingNumber(1, 1), weight: routingNumber(1, 1) },
    }),
    provider({
      id: 'c',
      override: { priority: routingNumber(1, 1), weight: routingNumber(1, 1) },
    }),
  ];
  const previousRows = [
    { providerId: 'a', priority: 2, weight: 1 },
    { providerId: 'b', priority: 1, weight: 1 },
    { providerId: 'c', priority: 1, weight: 1 },
  ];
  const previousLayout = {
    tiers: [
      { id: 'tier:2', itemIds: ['a'] },
      { id: 'tier:1', itemIds: ['b', 'c'] },
    ],
    parking: { unused: [] },
  } satisfies WeightedTierLayout;
  expect(
    applyRoutingBoardLayout({
      providers: tight,
      previousRows,
      previousLayout,
      nextLayout: {
        tiers: [
          { id: 'tier:2', itemIds: ['a'] },
          { id: 'tier:new:1', itemIds: ['c'] },
          { id: 'tier:1', itemIds: ['b'] },
        ],
        parking: previousLayout.parking,
      },
      operation: { type: 'item', id: 'c' },
    }),
  ).toEqual([
    { providerId: 'a', priority: 30 },
    { providerId: 'b', priority: 10 },
    { providerId: 'c', priority: 20 },
  ]);
});

test('a fully packed model board keeps every tier distinct when it has to compact', () => {
  // Interpolation fails for a whole-tier move across a board that already uses every priority, so
  // this falls through to compaction. The supported range holds exactly 10001 values, and the
  // lowest tier has to take 0 for all of them to stay apart.
  const packed = Array.from({ length: 10_001 }, (_, index) => tierProvider(`p${index}`, 10_000 - index, 1));
  const previousRows = packed.map((entry, index) => ({ providerId: entry.id, priority: 10_000 - index, weight: 1 }));
  const previousLayout = {
    tiers: packed.map((entry, index) => ({ id: `tier:${10_000 - index}`, itemIds: [entry.id] })),
    parking: { unused: [] },
  } satisfies WeightedTierLayout;
  const moved = previousLayout.tiers[0]!;

  const priorities = applyRoutingBoardLayout({
    providers: packed,
    previousRows,
    previousLayout,
    nextLayout: { ...previousLayout, tiers: [...previousLayout.tiers.slice(1), moved] },
    operation: { type: 'tier', id: moved.id },
    // A row omits a priority equal to the Provider default (0), so read the effective value back.
  }).map((row) => row.priority ?? 0);

  expect(new Set(priorities).size).toBe(10_001);
  expect(Math.max(...priorities)).toBe(10_000);
  expect(Math.min(...priorities)).toBe(0);
});

test('preserves a blocked Provider row when another Provider is dragged', () => {
  const withBlocked = [
    ...providers,
    provider({
      id: 'd',
      enabled: false,
      effective: {
        priority: 0,
        weight: 1,
        prioritySource: 'provider',
        weightSource: 'provider',
        eligible: false,
        share: null,
      },
    }),
  ];
  const previousRows = [...rows, { providerId: 'd' }];
  const previousLayout = {
    tiers: [{ id: 'tier:30', itemIds: ['a', 'b'] }],
    parking: { unused: ['c'], blocked: ['d'] },
  } satisfies WeightedTierLayout;
  expect(
    applyRoutingBoardLayout({
      providers: withBlocked,
      previousRows,
      previousLayout,
      nextLayout: {
        tiers: [
          { id: 'tier:30', itemIds: ['b'] },
          { id: 'tier:new:1', itemIds: ['a'] },
        ],
        parking: previousLayout.parking,
      },
      operation: { type: 'item', id: 'a' },
    }),
  ).toEqual([
    { providerId: 'a', priority: 20, weight: 6000 },
    { providerId: 'b' },
    { providerId: 'c', weight: 0 },
    { providerId: 'd' },
  ]);
});

test('moving a tier between existing priorities changes only the moved tier priority', () => {
  const tierProviders = [tierProvider('a', 30, 6000), tierProvider('b', 20, 4000), tierProvider('c', 10, 1000)];
  const previousRows = [
    { providerId: 'a', priority: 30, weight: 6000 },
    { providerId: 'b', priority: 20, weight: 4000 },
    { providerId: 'c', priority: 10, weight: 1000 },
  ];
  const previousLayout = {
    tiers: [
      { id: 'tier:30', itemIds: ['a'] },
      { id: 'tier:20', itemIds: ['b'] },
      { id: 'tier:10', itemIds: ['c'] },
    ],
    parking: { unused: [] },
  } satisfies WeightedTierLayout;

  expect(
    applyRoutingBoardLayout({
      providers: tierProviders,
      previousRows,
      previousLayout,
      nextLayout: {
        ...previousLayout,
        tiers: [previousLayout.tiers[0]!, previousLayout.tiers[2]!, previousLayout.tiers[1]!],
      },
      operation: { type: 'tier', id: 'tier:10' },
    }),
  ).toEqual([
    { providerId: 'a', priority: 30, weight: 6000 },
    { providerId: 'b', priority: 20, weight: 4000 },
    { providerId: 'c', priority: 25, weight: 1000 },
  ]);
});

test('moving a tier into a tight priority gap compacts all active priorities', () => {
  const tierProviders = [tierProvider('a', 3, 1000), tierProvider('b', 2, 2000), tierProvider('c', 1, 3000)];
  const previousRows = [
    { providerId: 'a', priority: 3, weight: 1000 },
    { providerId: 'b', priority: 2, weight: 2000 },
    { providerId: 'c', priority: 1, weight: 3000 },
  ];
  const previousLayout = {
    tiers: [
      { id: 'tier:3', itemIds: ['a'] },
      { id: 'tier:2', itemIds: ['b'] },
      { id: 'tier:1', itemIds: ['c'] },
    ],
    parking: { unused: [] },
  } satisfies WeightedTierLayout;

  expect(
    applyRoutingBoardLayout({
      providers: tierProviders,
      previousRows,
      previousLayout,
      nextLayout: {
        ...previousLayout,
        tiers: [previousLayout.tiers[0]!, previousLayout.tiers[2]!, previousLayout.tiers[1]!],
      },
      operation: { type: 'tier', id: 'tier:1' },
    }),
  ).toEqual([
    { providerId: 'a', priority: 30, weight: 1000 },
    { providerId: 'b', priority: 10, weight: 2000 },
    { providerId: 'c', priority: 20, weight: 3000 },
  ]);
});

test('moving a tier preserves unused and blocked Provider rows', () => {
  const tierProviders = [
    tierProvider('a', 30, 6000),
    tierProvider('b', 20, 4000),
    provider({
      id: 'unused',
      override: { weight: routingNumber(0, 0) },
      effective: {
        priority: 0,
        weight: 0,
        prioritySource: 'provider',
        weightSource: 'model',
        eligible: false,
        share: null,
      },
    }),
    provider({
      id: 'blocked',
      enabled: false,
      effective: {
        priority: 0,
        weight: 1,
        prioritySource: 'provider',
        weightSource: 'provider',
        eligible: false,
        share: null,
      },
    }),
  ];
  const previousRows = [
    { providerId: 'a', priority: 30, weight: 6000 },
    { providerId: 'b', priority: 20, weight: 4000 },
    { providerId: 'unused', weight: 0 },
    { providerId: 'blocked' },
  ];
  const previousLayout = {
    tiers: [
      { id: 'tier:30', itemIds: ['a'] },
      { id: 'tier:20', itemIds: ['b'] },
    ],
    parking: { unused: ['unused'], blocked: ['blocked'] },
  } satisfies WeightedTierLayout;

  expect(
    applyRoutingBoardLayout({
      providers: tierProviders,
      previousRows,
      previousLayout,
      nextLayout: {
        ...previousLayout,
        tiers: [previousLayout.tiers[1]!, previousLayout.tiers[0]!],
      },
      operation: { type: 'tier', id: 'tier:20' },
    }),
  ).toEqual([
    { providerId: 'a', priority: 30, weight: 6000 },
    { providerId: 'b', priority: 40, weight: 4000 },
    { providerId: 'unused', weight: 0 },
    { providerId: 'blocked' },
  ]);
});

test('share slider keeps every tier member positive on the current tier total', () => {
  const three = [
    ...providers.slice(0, 2),
    provider({
      id: 'e',
      defaults: { priority: routingNumber(30), weight: routingNumber(1000) },
      effective: {
        priority: 30,
        weight: 1000,
        prioritySource: 'provider',
        weightSource: 'provider',
        eligible: true,
        share: 0.1,
      },
    }),
  ];
  expect(
    applyRoutingShare({
      providers: three,
      rows: [{ providerId: 'a', priority: 30, weight: 6000 }, { providerId: 'b' }, { providerId: 'e' }],
      memberIds: ['a', 'b', 'e'],
      providerId: 'a',
      weight: 9900,
    }),
  ).toEqual([
    { providerId: 'a', priority: 30, weight: 9900 },
    { providerId: 'b', weight: 879 },
    { providerId: 'e', weight: 221 },
  ]);
});

test('share slider can assign a 1-unit weight without rounding it away', () => {
  expect(
    applyRoutingShare({
      providers,
      rows,
      memberIds: ['a', 'b'],
      providerId: 'a',
      weight: 1,
    }),
  ).toEqual([
    { providerId: 'a', priority: 30 },
    { providerId: 'b', weight: 9999 },
    { providerId: 'c', weight: 0 },
  ]);
});

test('reserves one weight unit for every sibling when the leftover is skewed', () => {
  const three = [
    ...providers.slice(0, 2),
    provider({
      id: 'e',
      defaults: { priority: routingNumber(30), weight: routingNumber(1) },
      effective: {
        priority: 30,
        weight: 1,
        prioritySource: 'provider',
        weightSource: 'provider',
        eligible: true,
        share: 0.0001,
      },
    }),
  ];
  expect(
    applyRoutingShare({
      providers: three,
      rows: [
        { providerId: 'a', priority: 30, weight: 9999 },
        { providerId: 'b', weight: 9999 },
        { providerId: 'e', weight: 1 },
      ],
      memberIds: ['a', 'b', 'e'],
      providerId: 'a',
      weight: 9900,
    }),
  ).toEqual([
    { providerId: 'a', priority: 30, weight: 9900 },
    { providerId: 'b', weight: 10000 },
    { providerId: 'e', weight: 99 },
  ]);
});

test('preserves a 1-unit share when the tier total exceeds 10000', () => {
  const three = [
    provider({
      id: 'a',
      override: { priority: routingNumber(30, 30), weight: routingNumber(1, 1) },
    }),
    provider({
      id: 'b',
      defaults: { priority: routingNumber(30), weight: routingNumber(10000) },
    }),
    provider({
      id: 'e',
      defaults: { priority: routingNumber(30), weight: routingNumber(10000) },
    }),
  ];
  expect(
    applyRoutingShare({
      providers: three,
      rows: [{ providerId: 'a', priority: 30, weight: 1 }, { providerId: 'b' }, { providerId: 'e' }],
      memberIds: ['a', 'b', 'e'],
      providerId: 'a',
      weight: 1,
    }),
  ).toEqual([{ providerId: 'a', priority: 30 }, { providerId: 'b' }, { providerId: 'e' }]);
});

test('reassigns excess from a capped sibling instead of shrinking the tier', () => {
  const three = [
    provider({
      id: 'a',
      defaults: { priority: routingNumber(30), weight: routingNumber(1) },
      override: { priority: routingNumber(30, 30), weight: routingNumber(10000, 10000) },
    }),
    provider({
      id: 'b',
      defaults: { priority: routingNumber(30), weight: routingNumber(10000) },
    }),
    provider({
      id: 'e',
      defaults: { priority: routingNumber(30), weight: routingNumber(1) },
    }),
  ];
  expect(
    applyRoutingShare({
      providers: three,
      rows: [{ providerId: 'a', priority: 30, weight: 10000 }, { providerId: 'b' }, { providerId: 'e' }],
      memberIds: ['a', 'b', 'e'],
      providerId: 'a',
      weight: 1,
    }),
  ).toEqual([{ providerId: 'a' }, { providerId: 'b' }, { providerId: 'e', weight: 10000 }]);
});
