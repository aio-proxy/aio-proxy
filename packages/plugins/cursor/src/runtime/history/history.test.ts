import { expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';

import type { LanguageModelV4Prompt, LanguageModelV4ToolResultPart } from '@ai-sdk/provider';
import { fromBinary } from '@bufbuild/protobuf';

import { ConversationStepSchema, ConversationTurnStructureSchema } from '../../gen/agent_pb';
import { storeCursorBlob } from '../../store/blobs';
import {
  appendCursorRootHistory,
  applyMcpToolResults,
  buildConversationTurns,
  buildCursorSystemPromptJsons,
  buildRootPromptMessagesJson,
  findActiveUserMessageIndex,
} from './history';

const decodeJson = (store: Map<string, Uint8Array>, id: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(store.get(Buffer.from(id).toString('hex'))!));

const pairedPrompt: LanguageModelV4Prompt = [
  { role: 'user', content: [{ type: 'text', text: 'Compare searches.' }] },
  {
    role: 'assistant',
    content: [
      { type: 'tool-call', toolCallId: 'outer-a', toolName: 'search', input: { query: 'alpha' } },
      { type: 'tool-call', toolCallId: 'outer-b', toolName: 'search', input: { query: 'beta' } },
    ],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 'outer-a', toolName: 'search', output: { type: 'text', value: 'RESULT_A' } },
      { type: 'tool-result', toolCallId: 'outer-b', toolName: 'search', output: { type: 'text', value: 'RESULT_B' } },
    ],
  },
];

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

test('root history preserves same-name calls with different arguments and results', () => {
  const store = new Map<string, Uint8Array>();
  const ids = buildRootPromptMessagesJson(pairedPrompt, [], store, -1);
  const messages = ids.map((id) => decodeJson(store, id));
  const calls = messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.content)
    .filter((p) => p.type === 'tool-call');
  const results = messages.filter((m) => m.role === 'tool').flatMap((m) => m.content);
  expect(calls.map((c) => c.args)).toEqual([{ query: 'alpha' }, { query: 'beta' }]);
  expect(results.map((r) => r.result)).toEqual(['RESULT_A', 'RESULT_B']);
  expect(results.map((r) => r.toolCallId)).toEqual(calls.map((c) => c.toolCallId));
  expect(calls.every((c) => /^[a-zA-Z0-9_-]+$/.test(c.toolCallId))).toBe(true);
});

test('incremental results pair with calls already in cached root history', () => {
  const store = new Map<string, Uint8Array>();
  const base = buildRootPromptMessagesJson(pairedPrompt.slice(0, 2), [], store, -1);
  const ids = appendCursorRootHistory({
    rootPromptMessagesJson: base,
    prompt: pairedPrompt.slice(2),
    blobStore: store,
  });
  const messages = ids.map((id) => decodeJson(store, id));
  expect(
    messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content)
      .filter((p) => p.type === 'tool-call'),
  ).toHaveLength(2);
  expect(
    messages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content)
      .map((p) => p.result),
  ).toEqual(['RESULT_A', 'RESULT_B']);
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

test.each([
  { output: { type: 'text', value: '' }, result: '(no output)', isError: undefined },
  { output: { type: 'content', value: [] }, result: '(no output)', isError: undefined },
  { output: { type: 'json', value: { count: 2 } }, result: { count: 2 }, isError: undefined },
  { output: { type: 'error-text', value: 'denied' }, result: 'denied', isError: true },
  { output: { type: 'error-json', value: { code: 7 } }, result: { code: 7 }, isError: true },
  {
    output: { type: 'execution-denied', reason: 'User declined' },
    result: '[Tool Execution Denied]\nUser declined',
    isError: true,
  },
] satisfies Array<{ output: LanguageModelV4ToolResultPart['output']; result: unknown; isError: true | undefined }>)(
  'root preserves result semantics: $output.type',
  ({ output, result, isError }) => {
    const store = new Map<string, Uint8Array>();
    const prompt: LanguageModelV4Prompt = [
      ...pairedPrompt.slice(0, 2),
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'outer-a',
            toolName: 'search',
            output: structuredClone(output),
          },
        ],
      },
    ];
    const root = buildRootPromptMessagesJson(prompt, [], store, -1).map((id) => decodeJson(store, id));
    const actual = root.find((m) => m.role === 'tool').content[0];
    expect(actual.result).toEqual(result);
    expect(actual.isError).toBe(isError);
  },
);

test('partial results keep unmatched calls pending', () => {
  const prompt: LanguageModelV4Prompt = [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'outer-a',
          toolName: 'search',
          output: { type: 'text', value: 'RESULT_A' },
        },
      ],
    },
  ];
  const patched = applyMcpToolResults({
    prompt,
    turns: [],
    pendingToolCalls: new Map([
      ['outer-a', 'nested-a'],
      ['outer-b', 'nested-b'],
    ]),
    blobStore: new Map(),
  });
  expect([...patched.pendingToolCalls]).toEqual([['outer-b', 'nested-b']]);
});

test('incremental system replaces only when explicitly supplied', () => {
  const store = new Map<string, Uint8Array>();
  const systemId = storeCursorBlob(store, new TextEncoder().encode('{"role":"system","content":"original"}'));
  const base = buildRootPromptMessagesJson(pairedPrompt.slice(0, 2), [systemId], store, -1);
  const implicit = appendCursorRootHistory({
    rootPromptMessagesJson: base,
    prompt: pairedPrompt.slice(2),
    blobStore: store,
  });
  const explicit = appendCursorRootHistory({
    rootPromptMessagesJson: base,
    prompt: [{ role: 'system', content: 'updated' }, ...pairedPrompt.slice(2)],
    blobStore: store,
  });
  const systems = (ids: Uint8Array[]) => ids.map((id) => decodeJson(store, id)).filter((m) => m.role === 'system');
  expect(systems(implicit)).toEqual([{ role: 'system', content: 'original' }]);
  expect(systems(explicit)).toEqual([{ role: 'system', content: 'updated' }]);
});

test('special client ids remain distinct and are not encoded twice on append', () => {
  const clientIds = ['call|1/中文', 'call_1_中文'];
  const store = new Map<string, Uint8Array>();
  const prompt: LanguageModelV4Prompt = [
    {
      role: 'assistant',
      content: clientIds.map((id) => ({
        type: 'tool-call',
        toolCallId: id,
        toolName: 'search',
        input: { query: id },
      })),
    },
  ];
  const base = buildRootPromptMessagesJson(prompt, [], store, -1);
  const appended = appendCursorRootHistory({
    rootPromptMessagesJson: base,
    blobStore: store,
    prompt: [
      {
        role: 'tool',
        content: clientIds.map((id) => ({
          type: 'tool-result',
          toolCallId: id,
          toolName: 'search',
          output: { type: 'text', value: id },
        })),
      },
    ],
  }).map((id) => decodeJson(store, id));
  const calls = appended.filter((m) => m.role === 'assistant').flatMap((m) => m.content);
  const results = appended.filter((m) => m.role === 'tool').flatMap((m) => m.content);
  expect(new Set(calls.map((c) => c.toolCallId)).size).toBe(2);
  expect(calls.every((c) => /^[a-zA-Z0-9_-]+$/.test(c.toolCallId))).toBe(true);
  expect(results.map((r) => r.toolCallId)).toEqual(calls.map((c) => c.toolCallId));
  expect(results.map((r) => r.result)).toEqual(clientIds);
});
