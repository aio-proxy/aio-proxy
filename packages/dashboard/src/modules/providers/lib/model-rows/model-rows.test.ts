import { expect, test } from '@rstest/core';

import { applyModelRows, toModelRows } from './model-rows';

test('rows join models with their metadata', () => {
  expect(toModelRows(['a', 'b'], { a: { name: 'A' } })).toEqual([
    { id: 'a', metadata: { name: 'A' } },
    { id: 'b', metadata: undefined },
  ]);
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
  // A row carries the WHOLE record for its id (toModelRows seeded it from previous), so the row
  // must replace, never shallow-merge onto, the previous record for that id.
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
