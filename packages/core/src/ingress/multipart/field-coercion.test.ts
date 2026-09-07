import { describe, expect, test } from 'bun:test';

import { multipartFieldBoolean, multipartFieldNumber } from './field-coercion';

describe('multipartFieldNumber', () => {
  test.each([
    ['0', 0],
    ['42', 42],
    ['-1.5', -1.5],
    ['+1.5', 1.5],
    ['.5', 0.5],
    ['1.', 1],
    [' 0.2 ', 0.2],
  ] as const)('decodes the decimal literal %p', (value, expected) => {
    expect(multipartFieldNumber(value)).toBe(expected);
  });

  // `Number('')` and `Number(' ')` are 0, so an unguarded coercion would read a field
  // the client left blank as an explicit value rather than as "not sent".
  test.each([undefined, '', ' ', '\t\n'])('treats an empty part %p as absent', (value) => {
    expect(multipartFieldNumber(value)).toBeUndefined();
  });

  // `Number` accepts all of these; none is a spelling an OpenAI client emits, so each
  // must reach the caller's schema as NaN instead of a silently invented value.
  test.each(['0x10', '0b11', '0o17', 'Infinity', '-Infinity', '1_000', 'hot', '1,5', '٢'])(
    'rejects the non-decimal spelling %p as NaN',
    (value) => {
      expect(multipartFieldNumber(value)).toBeNaN();
    },
  );

  // A literal that overflows to Infinity is not a finite number the caller can use.
  test.each(['1e999', '-1e999'])('rejects the overflowing literal %p as NaN', (value) => {
    expect(multipartFieldNumber(value)).toBeNaN();
  });

  // Exponent semantics: the sign is optional and single (`e[+-]?`), matching JSON and
  // JS number grammar, so `1e+5` is a value and a doubled `e` is not.
  test.each([
    ['1e5', 100_000],
    ['1E5', 100_000],
    ['1e+5', 100_000],
    ['1e-5', 0.00001],
  ] as const)('decodes the exponent form %p', (value, expected) => {
    expect(multipartFieldNumber(value)).toBe(expected);
  });

  test.each(['1ee5', '1e', '1e+', 'e5'])('rejects the malformed exponent %p as NaN', (value) => {
    expect(multipartFieldNumber(value)).toBeNaN();
  });

  // Regression: `\d+\.?\d*` split a digit run ambiguously between two quantifiers, so
  // a trailing illegal character forced exponential backtracking — 40k chars took ~1.6s
  // of an event loop this process cannot yield out of, and a 200 KB field is inside the
  // 1 MiB non-file budget. The bound is loose on purpose: it must separate linear from
  // exponential on a loaded machine, not measure throughput. The pre-fix regex needs
  // tens of seconds for this input, the fixed one under a millisecond.
  test('rejects a long adversarial digit run without backtracking', () => {
    const adversarial = `${'9'.repeat(200_000)}x`;
    const started = Bun.nanoseconds();
    expect(multipartFieldNumber(adversarial)).toBeNaN();
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(1_000);
  });
});

describe('multipartFieldBoolean', () => {
  test.each([
    ['true', true],
    ['false', false],
    [' true ', true],
    [' false ', false],
  ] as const)('decodes the boolean literal %p', (value, expected) => {
    expect(multipartFieldBoolean(value)).toBe(expected);
  });

  // An empty part must never become `false`: a `curl -F 'stream='` did not opt out.
  test.each([undefined, '', ' ', '\t'])('treats an empty part %p as absent', (value) => {
    expect(multipartFieldBoolean(value)).toBeUndefined();
  });

  // Passed through verbatim so the caller's schema reports what the client sent
  // rather than coercing an unknown token to false.
  test.each(['yes', '1', 'TRUE', 'null'])('returns the non-literal %p unchanged', (value) => {
    expect(multipartFieldBoolean(value)).toBe(value);
  });
});
