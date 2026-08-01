import { expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';

import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { fromBinary } from '@bufbuild/protobuf';

import { ConversationTurnStructureSchema } from '../../gen/agent_pb';
import { storeCursorBlob } from '../../store/blobs';
import {
  buildConversationTurns,
  buildCursorSystemPromptJsons,
  buildRootPromptMessagesJson,
  findActiveUserMessageIndex,
} from './history';

const decodeJson = (store: Map<string, Uint8Array>, id: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(store.get(Buffer.from(id).toString('hex'))!));

test('emits a default system prompt when none is present', () => {
  expect(buildCursorSystemPromptJsons([])).toEqual([
    JSON.stringify({ role: 'system', content: 'You are a helpful assistant.' }),
  ]);
});

test('root prompt json excludes the active user turn and flattens tool results', () => {
  const prompt: LanguageModelV4Prompt = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'c1', toolName: 'search', output: { type: 'text', value: 'RESULT' } },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: 'second (active)' }] },
  ];
  const store = new Map<string, Uint8Array>();
  const activeIndex = findActiveUserMessageIndex(prompt);
  const systemIds = buildCursorSystemPromptJsons(prompt).map((json) =>
    storeCursorBlob(store, new TextEncoder().encode(json)),
  );
  const rootIds = buildRootPromptMessagesJson(prompt, systemIds, store, activeIndex);
  const decoded = rootIds.map((id) => decodeJson(store, id));
  expect(decoded).toContainEqual({ role: 'user', content: [{ type: 'text', text: 'first' }] });
  expect(decoded).toContainEqual({ role: 'user', content: [{ type: 'text', text: '[Tool Result]\nRESULT' }] });
  expect(JSON.stringify(decoded)).not.toContain('second (active)');
});

test('builds one agent turn from a completed user/assistant pair', () => {
  const prompt: LanguageModelV4Prompt = [
    { role: 'user', content: [{ type: 'text', text: 'q1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
    { role: 'user', content: [{ type: 'text', text: 'q2 active' }] },
  ];
  const store = new Map<string, Uint8Array>();
  const turns = buildConversationTurns(prompt, store, findActiveUserMessageIndex(prompt));
  expect(turns.length).toBe(1);
  const turn = fromBinary(ConversationTurnStructureSchema, store.get(Buffer.from(turns[0]!).toString('hex'))!);
  expect(turn.turn.case).toBe('agentConversationTurn');
});
