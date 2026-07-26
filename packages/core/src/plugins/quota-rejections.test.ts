import { describe, expect, test } from 'bun:test';

import { OAuthQuotaValidationError, validateOAuthQuotaSnapshot } from './quota';

function expectInvalid(value: unknown, path: readonly (string | number)[]): void {
  try {
    validateOAuthQuotaSnapshot(value);
    throw new Error('Expected quota validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthQuotaValidationError);
    expect((error as OAuthQuotaValidationError).path).toEqual(path);
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('value');
  }
}

describe('validateOAuthQuotaSnapshot', () => {
  test.each([
    ['snapshot', { items: [], extra: true }, ['extra']],
    ['item', { items: [{ id: 'item', label: 'Item', extra: true }] }, ['items', 0, 'extra']],
    ['reset inventory', { items: [], resetCredits: { availableCount: 0, extra: true } }, ['resetCredits', 'extra']],
    [
      'credit',
      { items: [], resetCredits: { availableCount: 1, items: [{ id: 'credit', extra: true }] } },
      ['resetCredits', 'items', 0, 'extra'],
    ],
  ] as const)('rejects unknown %s fields', (_name, value, path) => {
    expectInvalid(value, path);
  });

  test('rejects accessors without invoking them', () => {
    let reads = 0;
    const input = Object.defineProperty({}, 'items', {
      enumerable: true,
      get() {
        reads += 1;
        return [];
      },
    });

    expectInvalid(input, ['items']);
    expect(reads).toBe(0);
  });

  test('rejects symbol keys', () => {
    const input = { items: [] } as Record<PropertyKey, unknown>;
    input[Symbol('secret')] = true;
    expectInvalid(input, []);
  });

  test('rejects sparse arrays and extra array properties', () => {
    // oxlint-disable-next-line unicorn/no-new-array -- intentional sparse array; Array.from would fill holes with `undefined`
    const sparse = new Array(1);
    expectInvalid({ items: sparse }, ['items', 0]);

    const extra = [] as unknown[] & { note?: string };
    extra.note = 'unexpected';
    expectInvalid({ items: extra }, ['items', 'note']);
  });

  test('rejects a maximally large sparse array before constructing a length-sized index set', () => {
    const originalAdd = Set.prototype.add;
    const sentinel = new Error('length-proportional Set allocation');
    let numericIndexAdds = 0;
    let caught: unknown;
    Set.prototype.add = function add(value) {
      if (typeof value === 'string' && /^\d+$/u.test(value) && ++numericIndexAdds > 8) throw sentinel;
      return originalAdd.call(this, value);
    };
    try {
      // oxlint-disable-next-line unicorn/no-new-array -- intentional maximally sparse array; Array.from would allocate a dense array
      validateOAuthQuotaSnapshot({ items: new Array(0xffffffff) });
    } catch (error) {
      caught = error;
    } finally {
      Set.prototype.add = originalAdd;
    }

    expect(caught).toBeInstanceOf(OAuthQuotaValidationError);
    expect((caught as OAuthQuotaValidationError).path).toEqual(['items', 0]);
    expect(numericIndexAdds).toBe(0);
  });

  test('rejects custom prototypes', () => {
    const input = Object.assign(Object.create({ inherited: true }), { items: [] });
    expectInvalid(input, []);
  });

  test('rejects active cycles', () => {
    const input: { items: unknown[] } = { items: [] };
    input.items.push(input);
    expectInvalid(input, ['items', 0]);
  });

  test('rejects proxies without invoking their traps', () => {
    let trapCalls = 0;
    const input = new Proxy(
      { items: [] },
      {
        getPrototypeOf() {
          trapCalls += 1;
          return Object.prototype;
        },
        ownKeys() {
          trapCalls += 1;
          return ['items'];
        },
        getOwnPropertyDescriptor(target, key) {
          trapCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    expectInvalid(input, []);
    expect(trapCalls).toBe(0);
  });
});
