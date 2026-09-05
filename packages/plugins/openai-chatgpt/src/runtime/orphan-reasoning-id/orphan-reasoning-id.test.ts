import { describe, expect, test } from 'bun:test';

import { stripOrphanReasoningIds } from './orphan-reasoning-id';

const REASONING_ID = 'rs_resp_ab454c48-a211-44b7-b0af-15e95f510490_0';

describe('stripOrphanReasoningIds', () => {
  test('drops an id the upstream cannot look up while keeping the summary', () => {
    const input = [
      { type: 'reasoning', id: REASONING_ID, summary: [{ type: 'summary_text', text: 'Checked the weather.' }] },
      { role: 'user', content: 'And tomorrow?' },
    ];

    expect(stripOrphanReasoningIds(input)).toEqual([
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checked the weather.' }] },
      { role: 'user', content: 'And tomorrow?' },
    ]);
  });

  test('keeps the id when the item can replay by encrypted_content', () => {
    const input = [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-state', summary: [] }];

    expect(stripOrphanReasoningIds(input)).toBeUndefined();
  });

  test('drops the id when the blob is absent, empty, or not a string', () => {
    for (const encrypted of [null, '', 42]) {
      const stripped = stripOrphanReasoningIds([{ type: 'reasoning', id: 'rs_1', encrypted_content: encrypted }]);
      expect(stripped).toEqual([{ type: 'reasoning', encrypted_content: encrypted }]);
    }
  });

  test('leaves non-reasoning items with ids alone', () => {
    const input = [
      { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' },
      { type: 'compaction', id: 'cmp_1' },
    ];

    expect(stripOrphanReasoningIds(input)).toBeUndefined();
  });

  test('ignores an input that is not an item array', () => {
    expect(stripOrphanReasoningIds('hello')).toBeUndefined();
    expect(stripOrphanReasoningIds(undefined)).toBeUndefined();
  });
});
