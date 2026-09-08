import { expect, test } from 'bun:test';

import type { LanguageModelV4Prompt, LanguageModelV4ToolResultPart } from '@ai-sdk/provider';
import { create, fromBinary } from '@bufbuild/protobuf';

import { AgentClientMessageSchema, ConversationStateStructureSchema } from '../../gen/agent_pb';
import { storeCursorBlob } from '../../store/blobs';
import { buildCursorRunRequestBytes } from './run-request';

const decodeRun = (bytes: Uint8Array) => {
  const client = fromBinary(AgentClientMessageSchema, bytes);
  if (client.message.case !== 'runRequest') throw new Error('expected runRequest');
  return client.message.value;
};

const build = (prompt: LanguageModelV4Prompt) =>
  buildCursorRunRequestBytes({
    prompt,
    wireModelId: 'claude-4.5-sonnet',
    displayModelId: 'claude-4.5-sonnet',
    displayName: 'Claude',
    maxMode: false,
    state: { conversationId: 'conv-files', blobStore: new Map() },
  });

const resumeResults: Array<{
  label: string;
  output: LanguageModelV4ToolResultPart['output'];
  text: string;
  result: unknown;
  isError?: true;
}> = [
  { label: 'text', output: { type: 'text', value: 'FOUND' }, text: '[Tool Result]\nFOUND', result: 'FOUND' },
  {
    label: 'empty text',
    output: { type: 'text', value: '' },
    text: '[Tool Result]\n(no output)',
    result: '(no output)',
  },
  {
    label: 'whitespace text',
    output: { type: 'text', value: ' \n ' },
    text: '[Tool Result]\n(no output)',
    result: '(no output)',
  },
  {
    label: 'empty content',
    output: { type: 'content', value: [] },
    text: '[Tool Result]\n(no output)',
    result: '(no output)',
  },
  {
    label: 'execution denied with reason',
    output: { type: 'execution-denied', reason: 'User declined access to the repository.' },
    text: '[Tool Execution Denied]\nUser declined access to the repository.',
    result: '[Tool Execution Denied]\nUser declined access to the repository.',
    isError: true,
  },
  {
    label: 'execution denied without reason',
    output: { type: 'execution-denied' },
    text: '[Tool Execution Denied]\nTool execution was denied.',
    result: '[Tool Execution Denied]\nTool execution was denied.',
    isError: true,
  },
];

test.each(resumeResults.flatMap((result) => [true, false].map((fullHistory) => ({ ...result, fullHistory }))))(
  'a pending tool resume includes $label in the model prompt (full history: $fullHistory)',
  ({ fullHistory, output, text, result, isError }) => {
    const blobStore = new Map<string, Uint8Array>();
    const jsonBlob = (value: unknown) => storeCursorBlob(blobStore, new TextEncoder().encode(JSON.stringify(value)));
    const system = { role: 'system', content: 'sys' } as const;
    const user = { role: 'user', content: [{ type: 'text', text: 'search the docs' }] } as const;
    const prompt: LanguageModelV4Prompt = [
      system,
      ...(fullHistory
        ? ([
            { role: 'user', content: [{ type: 'text', text: 'search the docs' }] },
            {
              role: 'assistant',
              content: [{ type: 'tool-call', toolCallId: 'outer', toolName: 'search', input: { query: 'docs' } }],
            },
          ] as LanguageModelV4Prompt)
        : []),
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'outer', toolName: 'search', output }],
      },
    ];
    const { conversationState } = buildCursorRunRequestBytes({
      prompt,
      wireModelId: 'composer-2.5',
      displayModelId: 'composer-2.5',
      displayName: 'Composer',
      maxMode: false,
      state: {
        conversationId: 'conv-resume',
        blobStore,
        conversationState: create(ConversationStateStructureSchema, {
          rootPromptMessagesJson: [jsonBlob(system), ...(fullHistory ? [] : [jsonBlob(user)])],
        }),
        pendingToolCalls: new Map([['outer', 'nested']]),
      },
    });
    const history = conversationState.rootPromptMessagesJson.map((id) =>
      JSON.parse(new TextDecoder().decode(blobStore.get(Buffer.from(id).toString('hex')))),
    );

    expect(history).toContainEqual(user);
    if (fullHistory) {
      const results = history.filter((message) => message.role === 'tool').flatMap((message) => message.content);
      expect(results.map((part) => part.result)).toEqual([result]);
      expect(results[0]?.isError).toBe(isError);
      const calls = history
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => message.content)
        .filter((part) => part.type === 'tool-call');
      expect(calls.map((call) => call.args)).toEqual([{ query: 'docs' }]);
      expect(results.map((part) => part.toolCallId)).toEqual(calls.map((call) => call.toolCallId));
    } else {
      expect(history).toContainEqual({ role: 'user', content: [{ type: 'text', text }] });
    }
  },
);

test('an incremental resume that includes the assistant tool-call keeps the cached user request', () => {
  const blobStore = new Map<string, Uint8Array>();
  const jsonBlob = (value: unknown) => storeCursorBlob(blobStore, new TextEncoder().encode(JSON.stringify(value)));
  const system = { role: 'system', content: 'sys' } as const;
  const user = { role: 'user', content: [{ type: 'text', text: 'search the docs' }] } as const;
  const { conversationState } = buildCursorRunRequestBytes({
    prompt: [
      system,
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'outer', toolName: 'search', input: { query: 'docs' } }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'outer', toolName: 'search', output: { type: 'text', value: 'FOUND' } },
        ],
      },
    ],
    wireModelId: 'composer-2.5',
    displayModelId: 'composer-2.5',
    displayName: 'Composer',
    maxMode: false,
    state: {
      conversationId: 'conv-partial-tool-history',
      blobStore,
      conversationState: create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: [jsonBlob(system), jsonBlob(user)],
      }),
      pendingToolCalls: new Map([['outer', 'nested']]),
    },
  });
  const history = conversationState.rootPromptMessagesJson.map((id) =>
    JSON.parse(new TextDecoder().decode(blobStore.get(Buffer.from(id).toString('hex')))),
  );
  expect(history).toContainEqual(user);
  const results = history.filter((message) => message.role === 'tool').flatMap((message) => message.content);
  expect(results.map((part) => part.result)).toEqual(['FOUND']);
});

test('a trailing user message selects userMessageAction', () => {
  const prompt: LanguageModelV4Prompt = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
  ];
  const { requestBytes } = buildCursorRunRequestBytes({
    prompt,
    wireModelId: 'claude-4.5-sonnet',
    displayModelId: 'claude-4.5-sonnet',
    displayName: 'Claude',
    maxMode: false,
    state: { conversationId: 'conv-1', blobStore: new Map() },
  });
  const run = decodeRun(requestBytes);
  expect(run.action?.action.case).toBe('userMessageAction');
  expect(run.conversationId).toBe('conv-1');
  expect(run.modelDetails?.modelId).toBe('claude-4.5-sonnet');
});

test('an explicit empty trailing user message selects userMessageAction', () => {
  const run = decodeRun(build([{ role: 'user', content: [] }]).requestBytes);

  expect(run.action?.action.case).toBe('userMessageAction');
});

test('a matching full-history request preserves the reusable Cursor checkpoint', () => {
  const blobStore = new Map<string, Uint8Array>();
  const prompt: LanguageModelV4Prompt = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: 'first user' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'next turn' }] },
  ];
  const systemPrompt = storeCursorBlob(
    blobStore,
    new TextEncoder().encode(JSON.stringify({ role: 'system', content: 'sys' })),
  );
  const cachedUser = storeCursorBlob(
    blobStore,
    new TextEncoder().encode(JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'first user' }] })),
  );
  const cachedAssistant = storeCursorBlob(
    blobStore,
    new TextEncoder().encode(JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'first answer' }] })),
  );
  const cachedTurn = storeCursorBlob(blobStore, new TextEncoder().encode('richer-cached-turn'));
  const { conversationState } = buildCursorRunRequestBytes({
    prompt,
    wireModelId: 'claude-4.5-sonnet',
    displayModelId: 'claude-4.5-sonnet',
    displayName: 'Claude',
    maxMode: false,
    state: {
      conversationId: 'conv-checkpoint',
      blobStore,
      conversationState: create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: [systemPrompt, cachedUser, cachedAssistant],
        turns: [cachedTurn],
      }),
    },
  });

  expect(conversationState.rootPromptMessagesJson).toEqual([systemPrompt, cachedUser, cachedAssistant]);
  expect(conversationState.turns).toEqual([cachedTurn]);
});

test('an edited full-history request rebuilds instead of reusing stale cached turns', () => {
  const blobStore = new Map<string, Uint8Array>();
  const systemPrompt = storeCursorBlob(
    blobStore,
    new TextEncoder().encode(JSON.stringify({ role: 'system', content: 'sys' })),
  );
  const staleTurn = storeCursorBlob(blobStore, new TextEncoder().encode('stale-turn'));
  const { conversationState } = buildCursorRunRequestBytes({
    prompt: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'edited user' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'edited answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'branch from here' }] },
    ],
    wireModelId: 'claude-4.5-sonnet',
    displayModelId: 'claude-4.5-sonnet',
    displayName: 'Claude',
    maxMode: false,
    state: {
      conversationId: 'conv-edited',
      blobStore,
      conversationState: create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: [systemPrompt],
        turns: [staleTurn],
      }),
    },
  });

  expect(conversationState.turns).toHaveLength(1);
  expect(conversationState.turns).not.toEqual([staleTurn]);
});

test('a changed image in full history rebuilds instead of reusing stale cached turns', () => {
  const blobStore = new Map<string, Uint8Array>();
  const promptWithImage = (data: string): LanguageModelV4Prompt => [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'inspect this image' },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data } },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'analysis' }] },
    { role: 'user', content: [{ type: 'text', text: 'continue' }] },
  ];
  const initial = buildCursorRunRequestBytes({
    prompt: promptWithImage('AQID'),
    wireModelId: 'claude-4.5-sonnet',
    displayModelId: 'claude-4.5-sonnet',
    displayName: 'Claude',
    maxMode: false,
    state: { conversationId: 'conv-image', blobStore },
  });

  const changed = buildCursorRunRequestBytes({
    prompt: promptWithImage('BAUG'),
    wireModelId: 'claude-4.5-sonnet',
    displayModelId: 'claude-4.5-sonnet',
    displayName: 'Claude',
    maxMode: false,
    state: { conversationId: 'conv-image', blobStore, conversationState: initial.conversationState },
  });

  expect(changed.conversationState.turns).not.toEqual(initial.conversationState.turns);
});

test('an incremental request without inbound history preserves the reusable checkpoint', () => {
  const blobStore = new Map<string, Uint8Array>();
  const systemPrompt = storeCursorBlob(
    blobStore,
    new TextEncoder().encode(JSON.stringify({ role: 'system', content: 'sys' })),
  );
  const cachedTurn = storeCursorBlob(blobStore, new TextEncoder().encode('cached-turn'));
  const { conversationState } = buildCursorRunRequestBytes({
    prompt: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'incremental next turn' }] },
    ],
    wireModelId: 'claude-4.5-sonnet',
    displayModelId: 'claude-4.5-sonnet',
    displayName: 'Claude',
    maxMode: false,
    state: {
      conversationId: 'conv-incremental',
      blobStore,
      conversationState: create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: [systemPrompt],
        turns: [cachedTurn],
      }),
    },
  });

  expect(conversationState.turns).toEqual([cachedTurn]);
});

test('a changed system prompt rebuilds instead of reusing a checkpoint', () => {
  const blobStore = new Map<string, Uint8Array>();
  const staleSystemPrompt = storeCursorBlob(
    blobStore,
    new TextEncoder().encode(JSON.stringify({ role: 'system', content: 'old system' })),
  );
  const staleTurn = storeCursorBlob(blobStore, new TextEncoder().encode('stale-turn'));
  const { conversationState } = buildCursorRunRequestBytes({
    prompt: [
      { role: 'system', content: 'new system' },
      { role: 'user', content: [{ type: 'text', text: 'next turn' }] },
    ],
    wireModelId: 'claude-4.5-sonnet',
    displayModelId: 'claude-4.5-sonnet',
    displayName: 'Claude',
    maxMode: false,
    state: {
      conversationId: 'conv-checkpoint',
      blobStore,
      conversationState: create(ConversationStateStructureSchema, {
        rootPromptMessagesJson: [staleSystemPrompt],
        turns: [staleTurn],
      }),
    },
  });

  expect(conversationState.rootPromptMessagesJson).not.toEqual([staleSystemPrompt]);
  expect(conversationState.turns).toEqual([]);
});

test('a trailing tool result selects resumeAction', () => {
  const prompt: LanguageModelV4Prompt = [
    { role: 'user', content: [{ type: 'text', text: 'do it' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'search_docs', input: { q: 'x' } }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'search_docs',
          output: { type: 'json', value: { ok: true } },
        },
      ],
    },
  ];
  const { requestBytes } = buildCursorRunRequestBytes({
    prompt,
    wireModelId: 'claude-4.5-sonnet',
    displayModelId: 'claude-4.5-sonnet',
    displayName: 'Claude',
    maxMode: true,
    state: { conversationId: 'conv-2', blobStore: new Map() },
  });
  const run = decodeRun(requestBytes);
  expect(run.action?.action.case).toBe('resumeAction');
  expect(run.requestedModel?.maxMode).toBe(true);
});

test.each([
  ['inline PDF', { type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: 'AA==' } }],
  ['inline text document', { type: 'file', mediaType: 'text/plain', data: { type: 'text', text: 'doc' } }],
  [
    'URL image',
    { type: 'file', mediaType: 'image/png', data: { type: 'url', url: new URL('https://example.test/a.png') } },
  ],
  [
    'referenced image',
    { type: 'file', mediaType: 'image/png', data: { type: 'reference', reference: { cursor: 'blob-1' } } },
  ],
] as const)('rejects an unsupported %s before constructing a run request', (_name, part) => {
  expect(() => build([{ role: 'user', content: [part] }] as LanguageModelV4Prompt)).toThrow(
    /only supports text and inline image data/i,
  );
});

test('accepts inline image data when constructing a run request', () => {
  const run = decodeRun(
    build([
      {
        role: 'user',
        content: [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } }],
      },
    ]).requestBytes,
  );
  expect(run.action?.action.case).toBe('userMessageAction');
  if (run.action?.action.case !== 'userMessageAction') throw new Error('expected userMessageAction');
  expect(run.action.action.value.userMessage?.selectedContext?.selectedImages).toHaveLength(1);
});
