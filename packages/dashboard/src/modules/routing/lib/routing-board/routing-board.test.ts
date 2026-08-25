import type { DashboardRoutingProvider } from '@aio-proxy/types';
import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import {
  ROUTING_BOARD_HIGH,
  ROUTING_BOARD_UNUSED,
  applyRoutingBoardMove,
  applyRoutingShare,
  buildRoutingBoard,
  listsFromBoard,
  sameListMembership,
  routingBoardAfterListId,
  routingBoardTierListId,
} from './routing-board';

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

test('groups eligible Providers by priority and parks zero-weight ones as unused', () => {
  const board = buildRoutingBoard(providers, rows);
  expect(board.tiers).toEqual([
    {
      priority: 30,
      items: [
        { providerId: 'a', draggable: true, share: 0.6 },
        { providerId: 'b', draggable: true, share: 0.4 },
      ],
    },
  ]);
  expect(board.unused).toEqual([{ providerId: 'c', draggable: true, share: null }]);
});

test('keeps weights when only the order inside a tier changes', () => {
  const previousLists = listsFromBoard(buildRoutingBoard(providers, rows));
  const nextLists = {
    ...previousLists,
    [routingBoardTierListId(30)]: ['b', 'a'],
  };
  expect(sameListMembership(previousLists, nextLists)).toBe(true);
  expect(applyRoutingBoardMove({ providers, previousRows: rows, previousLists, nextLists })).toEqual(rows);
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
  const previousLists = listsFromBoard(buildRoutingBoard(providers, rows));
  const nextLists = {
    ...previousLists,
    [routingBoardTierListId(30)]: ['b'],
    [routingBoardAfterListId(30)]: ['a'],
  };
  expect(applyRoutingBoardMove({ providers, previousRows: rows, previousLists, nextLists })).toEqual([
    { providerId: 'a', priority: 20, weight: 6000 },
    { providerId: 'b' },
    { providerId: 'c', weight: 0 },
  ]);
});

test('unused sets weight to zero and dropping back restores a positive weight', () => {
  const previousLists = listsFromBoard(buildRoutingBoard(providers, rows));
  const disabled = applyRoutingBoardMove({
    providers,
    previousRows: rows,
    previousLists,
    nextLists: {
      ...previousLists,
      [routingBoardTierListId(30)]: ['b'],
      [ROUTING_BOARD_UNUSED]: ['c', 'a'],
    },
  });
  expect(disabled).toEqual([
    { providerId: 'a', priority: 30, weight: 0 },
    { providerId: 'b' },
    { providerId: 'c', weight: 0 },
  ]);
  const restoredLists = {
    ...previousLists,
    [routingBoardTierListId(30)]: ['b', 'a'],
    [ROUTING_BOARD_UNUSED]: ['c'],
  };
  expect(
    applyRoutingBoardMove({
      providers,
      previousRows: disabled,
      previousLists: {
        ...previousLists,
        [routingBoardTierListId(30)]: ['b'],
        [ROUTING_BOARD_UNUSED]: ['c', 'a'],
      },
      nextLists: restoredLists,
    }),
  ).toEqual([{ providerId: 'a', priority: 30 }, { providerId: 'b' }, { providerId: 'c', weight: 0 }]);
});

test('new highest slot allocates an open priority', () => {
  const previousLists = listsFromBoard(buildRoutingBoard(providers, rows));
  expect(
    applyRoutingBoardMove({
      providers,
      previousRows: rows,
      previousLists,
      nextLists: {
        ...previousLists,
        [ROUTING_BOARD_HIGH]: ['a'],
        [routingBoardTierListId(30)]: ['b'],
      },
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
  const previousLists = {
    [ROUTING_BOARD_HIGH]: [],
    [routingBoardTierListId(2)]: ['a'],
    [routingBoardAfterListId(2)]: [],
    [routingBoardTierListId(1)]: ['b'],
    [routingBoardAfterListId(1)]: [],
    [ROUTING_BOARD_UNUSED]: [],
  };
  expect(
    applyRoutingBoardMove({
      providers: tight,
      previousRows,
      previousLists,
      nextLists: {
        ...previousLists,
        [routingBoardAfterListId(2)]: ['c'],
        [routingBoardTierListId(1)]: ['b'],
      },
    }),
  ).toEqual([
    { providerId: 'a', priority: 30 },
    { providerId: 'b', priority: 10 },
    { providerId: 'c', priority: 20 },
  ]);
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
  const previousLists = listsFromBoard(buildRoutingBoard(withBlocked, previousRows));
  expect(previousLists[ROUTING_BOARD_UNUSED]).toEqual(['c']);
  expect(
    applyRoutingBoardMove({
      providers: withBlocked,
      previousRows,
      previousLists,
      nextLists: {
        ...previousLists,
        [routingBoardTierListId(30)]: ['b'],
        [routingBoardAfterListId(30)]: ['a'],
      },
    }),
  ).toEqual([
    { providerId: 'a', priority: 20, weight: 6000 },
    { providerId: 'b' },
    { providerId: 'c', weight: 0 },
    { providerId: 'd' },
  ]);
});

test('share slider keeps every tier member positive on the 10000 weight scale', () => {
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
    { providerId: 'b', weight: 79 },
    { providerId: 'e', weight: 21 },
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
  ).toEqual([{ providerId: 'a', priority: 30, weight: 9900 }, { providerId: 'b', weight: 99 }, { providerId: 'e' }]);
});
