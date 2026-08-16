import { expect, test } from '@rstest/core';

import { applyModelRows, modelRowContext, toModelRows } from './model-rows';

// Metadata is user-authored JSON, and the row renders this number as a context badge. Every shape
// below has to read as "no override" rather than as a badge saying `NaN`, `0`, or crashing the row:
// `limit` need not be an object, `context` need not be a number, and a number need not be positive.
test('an unusable limit.context override reads as absent, whatever shape it has', () => {
  expect(modelRowContext({ limit: { context: 128_000 } })).toBe(128_000);
  expect(modelRowContext(undefined)).toBeUndefined();
  // A scalar `limit` would make the property read throw without the object guard.
  expect(modelRowContext({ limit: 128_000 })).toBeUndefined();
  expect(modelRowContext({ limit: null })).toBeUndefined();
  // JSON-authored numbers arrive as strings often enough; `Number.isFinite` is not enough alone.
  expect(modelRowContext({ limit: { context: '128000' } })).toBeUndefined();
  expect(modelRowContext({ limit: { context: Number.NaN } })).toBeUndefined();
  // Zero and negatives are not "a small context window", they are noise.
  expect(modelRowContext({ limit: { context: 0 } })).toBeUndefined();
  expect(modelRowContext({ limit: { context: -1 } })).toBeUndefined();
});

test('rows join models with their metadata', () => {
  expect(toModelRows(['a', 'b'], { a: { name: 'A' } })).toEqual([
    { id: 'a', metadata: { name: 'A' } },
    { id: 'b', metadata: undefined },
  ]);
  // The common case — a provider with no metadata at all — takes a different branch from `b` above
  // (`metadata?.[id]` short-circuits on the argument, not the key). Without this line, returning `{}`
  // for every row of every metadata-less provider goes unnoticed, and any downstream
  // `metadata !== undefined` has-metadata badge or dirty check then misfires on every row.
  expect(toModelRows(['a'], undefined)).toEqual([{ id: 'a', metadata: undefined }]);
});

test('every row is applied, and models keeps the row order', () => {
  const rows = [
    { id: 'b', metadata: { name: 'B' } },
    { id: 'a', metadata: { name: 'A' } },
  ];
  // The only test where the rows loop is seen ITERATING, and the only one whose ids are not already
  // sorted. Every other test passes a single row, so both of these are invisible: processing only
  // the first row drops every other model's metadata on save, and reordering `models` churns the
  // config file diff on every save.
  expect(applyModelRows(rows, undefined)).toEqual({
    models: ['b', 'a'],
    metadata: { b: { name: 'B' }, a: { name: 'A' } },
  });
});

test('round trip keeps metadata for alias-only models and unrecognized fields', () => {
  const previous = { 'alias-only': { extend: 'openai/gpt-y', unknownField: 1 }, a: { cost: { input: 1 } } };
  const rows = toModelRows(['a'], previous);
  const applied = applyModelRows(rows, previous);
  expect(applied.models).toEqual(['a']);
  expect(applied.metadata).toEqual(previous);
});

test('a row metadata record replaces the previous record for that id', () => {
  const previous = { a: { cost: { input: 1 }, removedInDrawer: true } };
  const rows = [{ id: 'a', metadata: { cost: { input: 2 } } }];
  // A row carries the WHOLE record for its id (toModelRows seeded it from previous), so fields the
  // drawer removed from that record must not come back from `previousMetadata`. This does NOT pin
  // replace-vs-shallow-merge: the preservation guard leaves `merged[row.id]` unset when the rows
  // loop runs, so merging onto it is an equivalent mutant.
  expect(applyModelRows(rows, previous).metadata).toEqual({ a: { cost: { input: 2 } } });
});

test('clearing a row metadata drops the stored record instead of reviving it', () => {
  const previous = { a: { cost: { input: 1 } }, 'alias-only': { extend: 'openai/gpt-y' } };
  // The only test that pins two clauses of `applyModelRows`, both invisible to every test above
  // because the rows loop overwrites whatever the previous loop let through: drop the
  // `!rowIds.has(id)` guard and the cleared record is revived from `previousMetadata`; drop the
  // `Object.keys(row.metadata).length > 0` half and it comes back as an empty `{}`.
  expect(applyModelRows([{ id: 'a', metadata: {} }], previous).metadata).toEqual({
    'alias-only': { extend: 'openai/gpt-y' },
  });
});

test('empty metadata collapses to undefined', () => {
  expect(applyModelRows([{ id: 'a', metadata: undefined }], undefined)).toEqual({ models: ['a'], metadata: undefined });
});
