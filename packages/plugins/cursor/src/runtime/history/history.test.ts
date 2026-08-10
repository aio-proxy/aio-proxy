import { expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';

import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { fromBinary } from '@bufbuild/protobuf';

import { ConversationStepSchema, ConversationTurnStructureSchema } from '../../gen/agent_pb';
import { storeCursorBlob } from '../../store/blobs';
import {
  applyMcpToolResults,
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

test('resumed MCP results preserve inline image bytes and MIME type', () => {
  const store = new Map<string, Uint8Array>();
  const prompt: LanguageModelV4Prompt = [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'outer-call',
          toolName: 'screenshot',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: 'captured' },
              {
                type: 'file',
                mediaType: 'image/png',
                data: { type: 'data', data: 'AQIDBA==' },
              },
            ],
          },
        },
      ],
    },
  ];

  const { turns } = applyMcpToolResults({
    prompt,
    turns: [],
    pendingToolCalls: new Map([['outer-call', 'nested-call']]),
    blobStore: store,
  });
  const turn = fromBinary(ConversationTurnStructureSchema, store.get(Buffer.from(turns[0]!).toString('hex'))!);
  if (turn.turn.case !== 'agentConversationTurn') throw new Error('expected agent turn');
  const step = fromBinary(ConversationStepSchema, store.get(Buffer.from(turn.turn.value.steps[0]!).toString('hex'))!);
  if (step.message.case !== 'toolCall' || step.message.value.tool.case !== 'mcpToolCall') {
    throw new Error('expected MCP tool call');
  }
  const result = step.message.value.tool.value.result?.result;
  expect(result?.case).toBe('success');
  if (result?.case !== 'success') throw new Error('expected MCP success');
  expect(result.value?.content[0]?.content).toMatchObject({ case: 'text', value: { text: 'captured' } });
  expect(result.value?.content[1]?.content).toMatchObject({
    case: 'image',
    value: { mimeType: 'image/png', data: new Uint8Array([1, 2, 3, 4]) },
  });
});
