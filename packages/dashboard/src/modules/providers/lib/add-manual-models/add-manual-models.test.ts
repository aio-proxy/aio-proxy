import { describe, expect, test } from '@rstest/core';

import { addManualModels, parseManualModelIds } from './add-manual-models';

describe('parseManualModelIds', () => {
  test('splits on commas and whitespace and drops empty pieces', () => {
    expect(parseManualModelIds('gpt-5-mini, gpt-5')).toEqual(['gpt-5-mini', 'gpt-5']);
    expect(parseManualModelIds('  a   b\nc,')).toEqual(['a', 'b', 'c']);
    expect(parseManualModelIds('   ')).toEqual([]);
  });
});

describe('addManualModels', () => {
  test('prepends a new id and leaves an already-listed id where it is', () => {
    expect(addManualModels(['model-a'], ['model-z'])).toEqual(['model-z', 'model-a']);
    expect(addManualModels(['model-a', 'model-b'], ['model-b'])).toEqual(['model-a', 'model-b']);
  });

  test('prepends several new ids in typed order and skips duplicates', () => {
    expect(addManualModels(['kept'], ['fresh-a', 'kept', 'fresh-b'])).toEqual(['fresh-a', 'fresh-b', 'kept']);
  });
});
