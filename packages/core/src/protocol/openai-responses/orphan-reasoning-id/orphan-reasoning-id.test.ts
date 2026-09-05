import { expect, test } from 'bun:test';

import { stripOrphanReasoningIds } from './orphan-reasoning-id';

const CIPHER = `gAAAA${'A'.repeat(80)}`;

test('strips the id from a reasoning item that has no blob to replay', () => {
  expect(
    stripOrphanReasoningIds(
      [
        { type: 'reasoning', id: 'rs_resp_ab454c48-a211-44b7-b0af-15e95f510490_0', summary: [] },
        { type: 'message', role: 'user', content: 'hi' },
      ],
      false,
    ),
  ).toEqual([
    { type: 'reasoning', summary: [] },
    { type: 'message', role: 'user', content: 'hi' },
  ]);
});

test('keeps the summary so the replayed transcript is not shortened', () => {
  expect(
    stripOrphanReasoningIds(
      [{ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'think' }] }],
      undefined,
    ),
  ).toEqual([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] }]);
});

test('keeps the id when the item carries a replayable blob', () => {
  expect(
    stripOrphanReasoningIds([{ type: 'reasoning', id: 'rs_1', encrypted_content: CIPHER, summary: [] }], false),
  ).toBeUndefined();
});

test('strips the id when encrypted_content is present but unusable', () => {
  for (const encrypted of [null, '', 'not ciphertext', 42]) {
    expect(stripOrphanReasoningIds([{ type: 'reasoning', id: 'rs_1', encrypted_content: encrypted }], false)).toEqual([
      { type: 'reasoning', encrypted_content: encrypted },
    ]);
  }
});

test('leaves non-reasoning items alone even when they carry an id', () => {
  expect(
    stripOrphanReasoningIds(
      [
        { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell', arguments: '{}' },
        { type: 'compaction', id: 'cmp_1' },
      ],
      false,
    ),
  ).toBeUndefined();
});

test('leaves the body alone when the caller opted into store', () => {
  expect(stripOrphanReasoningIds([{ type: 'reasoning', id: 'rs_1', summary: [] }], true)).toBeUndefined();
});

test('ignores a non-array input', () => {
  expect(stripOrphanReasoningIds('hello', false)).toBeUndefined();
  expect(stripOrphanReasoningIds(undefined, false)).toBeUndefined();
});
