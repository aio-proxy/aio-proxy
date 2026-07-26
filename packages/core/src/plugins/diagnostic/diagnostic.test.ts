import { describe, expect, test } from 'bun:test';

import { collectSecretStrings } from '.';

describe('redactPluginError', () => {
  test('skips proxies and accessors without invoking them', () => {
    const shared = { value: 'shared-secret' };
    let proxyTraps = 0;
    const hostile = new Proxy(
      { blocked: 'unread', values: ['array-secret', '', shared] },
      {
        ownKeys() {
          proxyTraps++;
          throw new Error('blocked proxy keys');
        },
      },
    );
    let getterReads = 0;
    const accessor = Object.defineProperty({}, 'secret', {
      get() {
        getterReads++;
        return 'accessor-secret';
      },
    });
    const input: Record<string, unknown> = {
      first: 'root-secret',
      shared,
      duplicate: shared,
      hostile,
      accessor,
    };
    Object.assign(input, { cycle: input });

    expect(collectSecretStrings(input)).toEqual(['root-secret', 'shared-secret']);
    expect(proxyTraps).toBe(0);
    expect(getterReads).toBe(0);
  });

  test('detects Map and Set without traversing a proxy-backed prototype chain', () => {
    let prototypeTraps = 0;
    const proxyPrototype = new Proxy(
      {},
      {
        getPrototypeOf() {
          prototypeTraps++;
          throw new Error('prototype traversal blocked');
        },
      },
    );
    const value = Object.create(proxyPrototype);
    Object.defineProperty(value, 'secret', { value: 'own-secret', enumerable: false });

    expect(collectSecretStrings(value)).toEqual(['own-secret']);
    expect(prototypeTraps).toBe(0);
  });

  test('collects Map, Set, symbol, non-enumerable, array, and class data fields through cycles', () => {
    const symbol = Symbol('secret');
    class CredentialBox {
      public visible = 'class-secret';
    }
    const described = Object.defineProperties(new CredentialBox(), {
      hidden: { value: 'hidden-secret', enumerable: false },
      [symbol]: { value: 'symbol-secret', enumerable: false },
    });
    const map = new Map<unknown, unknown>([['map-key-secret', described]]);
    const set = new Set<unknown>(['set-secret', map]);
    map.set('cycle', set);

    expect(collectSecretStrings([map, set, 'array-secret'])).toEqual([
      'map-key-secret',
      'class-secret',
      'hidden-secret',
      'symbol-secret',
      'cycle',
      'set-secret',
      'array-secret',
    ]);
  });
});
