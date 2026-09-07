import { expect, test } from 'bun:test';

import { create, toBinary } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';

import { InteractionUpdateSchema, McpArgsSchema } from '../../../gen/agent_pb';
import { buildMcpToolDefinitions } from '../../mcp-tools';
import {
  commitCursorTools,
  createCursorStreamAccumulator,
  cursorCompletedTools,
  cursorToolState,
  finalizeCursorStream,
  mapInteractionUpdate,
  mapMcpExec,
} from './interaction';

const update = (value: Record<string, unknown>) => create(InteractionUpdateSchema, { message: value } as never);
const argValue = (json: unknown) =>
  toBinary(ValueSchema, create(ValueSchema, { kind: { case: 'stringValue', value: JSON.stringify(json) } }));
const mcp = (input: Record<string, Uint8Array> = {}) =>
  create(McpArgsSchema, {
    name: 'search',
    toolName: 'search',
    toolCallId: 'nested',
    args: input,
  });
const mcpUpdate = (
  event: 'toolCallStarted' | 'partialToolCall' | 'toolCallCompleted',
  args: ReturnType<typeof mcp>,
  argsTextDelta?: string,
) =>
  update({
    case: event,
    value: {
      callId: 'outer',
      ...(argsTextDelta === undefined ? {} : { argsTextDelta }),
      toolCall: { tool: { case: 'mcpToolCall', value: { args } } },
    },
  });

test.each([
  { snapshots: [], finalArgs: { query: argValue('docs') }, want: '{"query":"docs"}' },
  { snapshots: ['{"query":"dr'], finalArgs: { query: argValue('docs') }, want: '{"query":"docs"}' },
  {
    snapshots: ['{"filters":{"lang":"ts"'],
    finalArgs: { filters: argValue({ lang: 'ts' }) },
    want: '{"filters":{"lang":"ts"}}',
  },
  { snapshots: ['{"query":"draft"}'], finalArgs: { query: argValue('docs') }, want: '{"query":"docs"}' },
  {
    snapshots: ['{"query":"docs","maxFiles":6}'],
    finalArgs: { maxFiles: argValue(10) },
    want: '{"query":"docs","maxFiles":10}',
  },
  {
    snapshots: ['{"tasks":[{"query":"docs"}],"options":{"limit":6}}'],
    finalArgs: { tasks: argValue('[truncated'), options: argValue('{truncated') },
    want: '{"tasks":[{"query":"docs"}],"options":{"limit":6}}',
  },
  { snapshots: ['{"query":', '{"query":"docs"}'], finalArgs: {}, want: '{"query":"docs"}' },
  { snapshots: [], finalArgs: {}, want: '{}', declaredEmpty: true },
])('MCP argument stream matches the completed call: %j', ({ snapshots, finalArgs, want, declaredEmpty }) => {
  const accumulator = createCursorStreamAccumulator(
    declaredEmpty
      ? buildMcpToolDefinitions([
          {
            type: 'function',
            name: 'search',
            inputSchema: { type: 'object', properties: {}, required: [] },
          },
        ])
      : [],
  );
  const parts = [
    ...mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), accumulator),
    ...snapshots.flatMap((argsTextDelta) =>
      mapInteractionUpdate(mcpUpdate('partialToolCall', mcp(), argsTextDelta), accumulator),
    ),
    ...mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp(finalArgs)), accumulator),
    ...commitCursorTools(accumulator),
  ];
  const streamedInput = parts
    .filter((part) => part.type === 'tool-input-delta')
    .map((part) => (part as { delta: string }).delta)
    .join('');

  expect(streamedInput).toBe(want);
  expect(parts.find((part) => part.type === 'tool-call')).toMatchObject({ input: want });
  expect(parts.findLastIndex((part) => part.type === 'tool-input-delta')).toBeLessThan(
    parts.findIndex((part) => part.type === 'tool-input-end'),
  );
});

test('text deltas stream and finalize as a stop finish', () => {
  const accumulator = createCursorStreamAccumulator();
  const parts = [
    ...mapInteractionUpdate(update({ case: 'textDelta', value: { text: 'Hel' } }), accumulator),
    ...mapInteractionUpdate(update({ case: 'textDelta', value: { text: 'lo' } }), accumulator),
    ...finalizeCursorStream(accumulator),
  ];
  expect(parts.filter((p) => p.type === 'text-delta').map((p) => (p as { delta: string }).delta)).toEqual([
    'Hel',
    'lo',
  ]);
  const finish = parts.at(-1) as { type: 'finish'; finishReason: { unified: string }; usage: unknown };
  expect(finish.type).toBe('finish');
  expect(finish.finishReason.unified).toBe('stop');
});

test('a completed MCP tool call keeps streamed arguments when the final map is empty', () => {
  const accumulator = createCursorStreamAccumulator();
  const started = update({
    case: 'toolCallStarted',
    value: {
      callId: 'c1',
      toolCall: {
        tool: { case: 'mcpToolCall', value: { args: { name: 'aio_proxy__read', toolCallId: 'c1', args: {} } } },
      },
    },
  });
  const delta = update({ case: 'partialToolCall', value: { callId: 'c1', argsTextDelta: '{"path":"/x"}' } });
  const completed = update({
    case: 'toolCallCompleted',
    value: {
      callId: 'c1',
      toolCall: {
        tool: {
          case: 'mcpToolCall',
          value: { args: { name: 'aio_proxy__read', toolCallId: 'c1', args: {} } },
        },
      },
    },
  });
  const parts = [
    ...mapInteractionUpdate(started, accumulator),
    ...mapInteractionUpdate(delta, accumulator),
    ...mapInteractionUpdate(completed, accumulator),
    ...commitCursorTools(accumulator),
    ...finalizeCursorStream(accumulator),
  ];
  const toolCall = parts.find((p) => p.type === 'tool-call') as
    | { toolName: string; toolCallId: string; input: string }
    | undefined;
  expect(toolCall?.toolName).toBe('read');
  expect(toolCall?.toolCallId).toBe('c1');
  expect(JSON.parse(toolCall!.input)).toMatchObject({ path: '/x' });
  expect((parts.at(-1) as { finishReason: { unified: string } }).finishReason.unified).toBe('tool-calls');
});

test('interleaved MCP calls keep outer and nested IDs uncrossed', () => {
  const accumulator = createCursorStreamAccumulator();
  const interleaved = (
    event: 'toolCallStarted' | 'toolCallCompleted',
    outerCallId: string,
    nestedToolCallId: string,
    path: string,
  ) =>
    update({
      case: event,
      value: {
        callId: outerCallId,
        toolCall: {
          tool: {
            case: 'mcpToolCall',
            value: {
              args: {
                name: 'aio_proxy__read',
                toolCallId: nestedToolCallId,
                args: { path: argValue(path) },
              },
            },
          },
        },
      },
    });
  const parts = [
    ...mapInteractionUpdate(interleaved('toolCallStarted', 'outer-a', 'nested-a', '/a'), accumulator),
    ...mapInteractionUpdate(interleaved('toolCallStarted', 'outer-b', 'nested-b', '/b'), accumulator),
    ...mapInteractionUpdate(
      update({ case: 'partialToolCall', value: { callId: 'outer-a', argsTextDelta: '{"path":"/a"}' } }),
      accumulator,
    ),
    ...mapInteractionUpdate(
      update({ case: 'partialToolCall', value: { callId: 'outer-b', argsTextDelta: '{"path":"/b"}' } }),
      accumulator,
    ),
    ...mapInteractionUpdate(interleaved('toolCallCompleted', 'outer-a', 'nested-a', '/a'), accumulator),
    ...mapInteractionUpdate(interleaved('toolCallCompleted', 'outer-b', 'nested-b', '/b'), accumulator),
    ...commitCursorTools(accumulator),
  ];
  const calls = parts.filter((part) => part.type === 'tool-call') as Array<{
    toolCallId: string;
    input: string;
  }>;

  expect(calls.map(({ toolCallId, input }) => [toolCallId, JSON.parse(input)])).toEqual([
    ['outer-a', { path: '/a' }],
    ['outer-b', { path: '/b' }],
  ]);
  expect(cursorCompletedTools(accumulator)).toMatchObject([
    { outerCallId: 'outer-a', nestedToolCallId: 'nested-a' },
    { outerCallId: 'outer-b', nestedToolCallId: 'nested-b' },
  ]);
});

test('finalizing an incomplete MCP call does not emit or complete it', () => {
  const accumulator = createCursorStreamAccumulator();
  mapInteractionUpdate(
    update({
      case: 'toolCallStarted',
      value: {
        callId: 'outer-incomplete',
        toolCall: {
          tool: {
            case: 'mcpToolCall',
            value: { args: { name: 'search', toolCallId: 'nested-incomplete', args: {} } },
          },
        },
      },
    }),
    accumulator,
  );

  const emitted = finalizeCursorStream(accumulator).find((part) => part.type === 'tool-call');

  expect(emitted).toBeUndefined();
  expect(cursorCompletedTools(accumulator)).toEqual([]);
  expect(cursorToolState(accumulator).openCount).toBe(1);
});

test('usage distinguishes a missing token update from an observed zero', () => {
  const unknown = createCursorStreamAccumulator();
  mapInteractionUpdate(update({ case: 'textDelta', value: { text: 'Hi' } }), unknown);
  const unknownFinish = finalizeCursorStream(unknown).at(-1) as {
    usage: { outputTokens: { total: number | undefined } };
  };

  const zero = createCursorStreamAccumulator();
  mapInteractionUpdate(update({ case: 'tokenDelta', value: { tokens: 0 } }), zero);
  const zeroFinish = finalizeCursorStream(zero).at(-1) as {
    usage: { outputTokens: { total: number | undefined } };
  };

  expect(unknownFinish.usage.outputTokens.total).toBeUndefined();
  expect(zeroFinish.usage.outputTokens.total).toBe(0);
});

test('token deltas accumulate into usage.outputTokens.total', () => {
  const accumulator = createCursorStreamAccumulator();
  mapInteractionUpdate(update({ case: 'tokenDelta', value: { tokens: 7 } }), accumulator);
  mapInteractionUpdate(update({ case: 'tokenDelta', value: { tokens: 5 } }), accumulator);
  const finish = finalizeCursorStream(accumulator).at(-1) as {
    usage: { outputTokens: { total: number } };
  };
  expect(finish.usage.outputTokens.total).toBe(12);
});

test('a snapshot before started survives repeated started and a partial final map', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(mcpUpdate('partialToolCall', mcp(), '{"query":"docs","limit":6}'), a);
  mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), a);
  mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), a);
  mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp({ query: argValue('docs') })), a);
  const parts = commitCursorTools(a);
  expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({
    toolCallId: 'outer',
    input: '{"query":"docs","limit":6}',
  });
  expect(parts.filter((p) => p.type === 'tool-input-delta')).toHaveLength(1);
});

test('an empty completion waits for later authoritative exec args', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), a);
  mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp()), a);
  expect(cursorToolState(a)).toMatchObject({ openCount: 1, readyCount: 0 });
  expect(commitCursorTools(a)).toEqual([]);
  mapMcpExec(mcp({ query: argValue('docs') }), a);
  const parts = commitCursorTools(a);
  expect(parts.find((p) => p.type === 'tool-call')).toMatchObject({ input: '{"query":"docs"}' });
  expect(commitCursorTools(a)).toEqual([]);
});

test('an incomplete snapshot stays pending when the completion map is only partial', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(mcpUpdate('partialToolCall', mcp(), '{"query":"docs","content":"par'), a);
  mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp({ query: argValue('docs') })), a);
  expect(cursorToolState(a)).toMatchObject({ openCount: 1, readyCount: 0 });
  expect(commitCursorTools(a)).toEqual([]);
  mapMcpExec(mcp({ query: argValue('docs'), content: argValue('partial body') }), a);
  expect(commitCursorTools(a).find((part) => part.type === 'tool-call')).toMatchObject({
    input: '{"query":"docs","content":"partial body"}',
  });
});

test.each(['{"query":"docs","cont', '{"query":"docs",'])(
  'a snapshot truncated before the next field colon stays pending: %s',
  (snapshot) => {
    const a = createCursorStreamAccumulator();
    mapInteractionUpdate(mcpUpdate('partialToolCall', mcp(), snapshot), a);
    mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp({ query: argValue('docs') })), a);
    expect(cursorToolState(a)).toMatchObject({ openCount: 1, readyCount: 0 });
    expect(commitCursorTools(a)).toEqual([]);
  },
);

test('a truncated structured snapshot stays pending when the completion map is a degraded string', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(mcpUpdate('partialToolCall', mcp(), '{"filters":{"lang":"ts"'), a);
  mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp({ filters: argValue('degraded') })), a);
  expect(cursorToolState(a)).toMatchObject({ openCount: 1, readyCount: 0 });
  expect(commitCursorTools(a)).toEqual([]);
  mapMcpExec(mcp({ filters: argValue({ lang: 'ts' }) }), a);
  expect(commitCursorTools(a).find((part) => part.type === 'tool-call')).toMatchObject({
    input: '{"filters":{"lang":"ts"}}',
  });
});

test('a later complete snapshot readies a call that had a partial completion map', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(mcpUpdate('partialToolCall', mcp(), '{"query":"docs","content":"par'), a);
  mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp({ query: argValue('docs') })), a);
  mapInteractionUpdate(mcpUpdate('partialToolCall', mcp(), '{"query":"docs","content":"partial body"}'), a);
  expect(commitCursorTools(a).find((part) => part.type === 'tool-call')).toMatchObject({
    input: '{"query":"docs","content":"partial body"}',
  });
});

test.each(['{"query":', '[]', '"scalar"'])(
  'never converts incomplete/invalid input %s to an executable empty object',
  (text) => {
    const a = createCursorStreamAccumulator();
    mapInteractionUpdate(mcpUpdate('partialToolCall', mcp(), text), a);
    mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp()), a);
    expect(commitCursorTools(a)).toEqual([]);
    expect(cursorToolState(a).openCount).toBe(1);
  },
);

test.each([
  ['exec empty', true, false],
  ['declared no-arg completion', false, true],
] as const)('preserves legitimate empty input: %s', (_label, execEmpty, declaredEmpty) => {
  const tools = declaredEmpty
    ? buildMcpToolDefinitions([
        {
          type: 'function',
          name: 'search',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ])
    : [];
  const a = createCursorStreamAccumulator(tools);
  mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), a);
  if (execEmpty) mapMcpExec(mcp(), a);
  else mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp()), a);
  expect(commitCursorTools(a).find((p) => p.type === 'tool-call')).toMatchObject({ input: '{}' });
});

test.each([{ minProperties: 1 }, { additionalProperties: true }, { patternProperties: { '^x': { type: 'string' } } }])(
  'a dynamic object schema waits for exec instead of handing off empty completion: %j',
  (extra) => {
    const a = createCursorStreamAccumulator(
      buildMcpToolDefinitions([
        {
          type: 'function',
          name: 'search',
          inputSchema: { type: 'object', properties: {}, ...extra },
        },
      ]),
    );
    mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), a);
    mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp()), a);
    expect(cursorToolState(a)).toMatchObject({ openCount: 1, readyCount: 0 });
    expect(commitCursorTools(a)).toEqual([]);
    mapMcpExec(mcp({ query: argValue('docs') }), a);
    expect(commitCursorTools(a).find((part) => part.type === 'tool-call')).toMatchObject({
      input: '{"query":"docs"}',
    });
  },
);

test('a later approval-only exec drops a provisional MCP record', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp({ query: argValue('docs') })), a);
  expect(cursorToolState(a).readyCount).toBe(1);
  mapMcpExec(
    create(McpArgsSchema, {
      name: 'search',
      toolName: 'search',
      toolCallId: 'nested',
      smartModeApprovalOnly: true,
    }),
    a,
  );
  expect(cursorToolState(a)).toMatchObject({ openCount: 0, readyCount: 0 });
  expect(commitCursorTools(a)).toEqual([]);
  mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp({ query: argValue('docs') })), a);
  expect(commitCursorTools(a).find((part) => part.type === 'tool-call')).toMatchObject({
    input: '{"query":"docs"}',
  });
});

test('exec-first aliases upgrade to the observed outer id before commit', () => {
  const a = createCursorStreamAccumulator();
  mapMcpExec(mcp({ query: argValue('docs') }), a);
  mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), a);
  mapInteractionUpdate(update({ case: 'toolCallCompleted', value: { callId: 'outer' } }), a);
  mapMcpExec(mcp({ query: argValue('docs') }), a);
  const calls = commitCursorTools(a).filter((p) => p.type === 'tool-call');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ toolCallId: 'outer', input: '{"query":"docs"}' });
  expect(cursorCompletedTools(a)).toMatchObject([{ outerCallId: 'outer', nestedToolCallId: 'nested' }]);
});

test('merging awaiting half-bound records counts as MCP progress', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(
    mcpUpdate('toolCallStarted', create(McpArgsSchema, { name: 'search', toolName: 'search', args: {} })),
    a,
  );
  mapInteractionUpdate(
    update({
      case: 'toolCallStarted',
      value: {
        callId: '',
        toolCall: {
          tool: {
            case: 'mcpToolCall',
            value: {
              args: create(McpArgsSchema, { name: 'search', toolName: 'search', toolCallId: 'nested', args: {} }),
            },
          },
        },
      },
    }),
    a,
  );
  expect(cursorToolState(a)).toMatchObject({ openCount: 2, readyCount: 0 });
  const before = cursorToolState(a);
  mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), a);
  expect(cursorToolState(a)).toMatchObject({
    openCount: 1,
    readyCount: 0,
    progressRevision: before.progressRevision + 1,
    revision: before.revision + 1,
  });
});

test('half-bound outer and nested records merge when a later frame carries both ids', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(
    mcpUpdate('toolCallStarted', create(McpArgsSchema, { name: 'search', toolName: 'search', args: {} })),
    a,
  );
  mapMcpExec(mcp({ query: argValue('docs') }), a);
  mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp()), a);
  expect(commitCursorTools(a).filter((part) => part.type === 'tool-call')).toHaveLength(1);
  expect(cursorCompletedTools(a)).toMatchObject([{ outerCallId: 'outer', nestedToolCallId: 'nested' }]);
});

test('a linking frame cannot attach an outer to a different nested id', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), a);
  mapMcpExec(
    create(McpArgsSchema, {
      name: 'search',
      toolName: 'search',
      toolCallId: 'other-nested',
      args: { query: argValue('other') },
    }),
    a,
  );
  expect(() =>
    mapInteractionUpdate(
      mcpUpdate(
        'toolCallCompleted',
        create(McpArgsSchema, { name: 'search', toolName: 'search', toolCallId: 'other-nested', args: {} }),
      ),
      a,
    ),
  ).toThrow(expect.objectContaining({ code: 'cursor_tool_identity_conflict' }));
});

test('a reused identity with a different name fails before emitting tools', () => {
  const a = createCursorStreamAccumulator();
  mapMcpExec(mcp({ query: argValue('docs') }), a);
  expect(() =>
    mapMcpExec(
      create(McpArgsSchema, {
        ...mcp(),
        toolName: 'other',
        name: 'other',
      }),
      a,
    ),
  ).toThrow(expect.objectContaining({ code: 'cursor_tool_identity_conflict' }));
});

test('a call-id-only early snapshot increments revision only when the snapshot changes', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(
    update({
      case: 'partialToolCall',
      value: { callId: 'outer-b', argsTextDelta: '{"query":"be' },
    }),
    a,
  );
  expect(cursorToolState(a).revision).toBe(1);
  mapInteractionUpdate(
    update({
      case: 'partialToolCall',
      value: { callId: 'outer-b', argsTextDelta: '{"query":"be' },
    }),
    a,
  );
  expect(cursorToolState(a).revision).toBe(1);
});

test('exec-created calls adopt first-seen snapshot announcement order', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(
    update({ case: 'partialToolCall', value: { callId: 'outer-a', argsTextDelta: '{"query":"al' } }),
    a,
  );
  mapInteractionUpdate(
    update({ case: 'partialToolCall', value: { callId: 'outer-b', argsTextDelta: '{"query":"be' } }),
    a,
  );
  mapMcpExec(
    create(McpArgsSchema, {
      name: 'search',
      toolName: 'search',
      toolCallId: 'nested-b',
      args: { query: argValue('beta') },
    }),
    a,
  );
  mapMcpExec(
    create(McpArgsSchema, {
      name: 'search',
      toolName: 'search',
      toolCallId: 'nested-a',
      args: { query: argValue('alpha') },
    }),
    a,
  );
  const bind = (callId: string, nested: string) =>
    mapInteractionUpdate(
      update({
        case: 'toolCallStarted',
        value: {
          callId,
          toolCall: {
            tool: {
              case: 'mcpToolCall',
              value: { args: { name: 'search', toolName: 'search', toolCallId: nested, args: {} } },
            },
          },
        },
      }),
      a,
    );
  bind('outer-b', 'nested-b');
  bind('outer-a', 'nested-a');
  expect(commitCursorTools(a).filter((part) => part.type === 'tool-call')).toMatchObject([
    { toolCallId: 'outer-a', input: '{"query":"alpha"}' },
    { toolCallId: 'outer-b', input: '{"query":"beta"}' },
  ]);
});

test('identity-free snapshots keep first-seen announcement order', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(
    update({ case: 'partialToolCall', value: { callId: 'outer-a', argsTextDelta: '{"query":"al' } }),
    a,
  );
  mapInteractionUpdate(
    update({ case: 'partialToolCall', value: { callId: 'outer-b', argsTextDelta: '{"query":"be' } }),
    a,
  );
  const start = (callId: string, nested: string) =>
    mapInteractionUpdate(
      update({
        case: 'toolCallStarted',
        value: {
          callId,
          toolCall: {
            tool: {
              case: 'mcpToolCall',
              value: { args: { name: 'search', toolName: 'search', toolCallId: nested, args: {} } },
            },
          },
        },
      }),
      a,
    );
  start('outer-b', 'nested-b');
  mapMcpExec(
    create(McpArgsSchema, {
      name: 'search',
      toolName: 'search',
      toolCallId: 'nested-b',
      args: { query: argValue('beta') },
    }),
    a,
  );
  start('outer-a', 'nested-a');
  mapMcpExec(
    create(McpArgsSchema, {
      name: 'search',
      toolName: 'search',
      toolCallId: 'nested-a',
      args: { query: argValue('alpha') },
    }),
    a,
  );
  expect(commitCursorTools(a).filter((part) => part.type === 'tool-call')).toMatchObject([
    { toolCallId: 'outer-a', input: '{"query":"alpha"}' },
    { toolCallId: 'outer-b', input: '{"query":"beta"}' },
  ]);
});

test('a call-id-only early snapshot joins its later MCP identity', () => {
  const a = createCursorStreamAccumulator();
  mapInteractionUpdate(
    update({
      case: 'partialToolCall',
      value: {
        callId: 'outer',
        argsTextDelta: '{"query":"docs","limit":6}',
      },
    }),
    a,
  );
  mapInteractionUpdate(mcpUpdate('toolCallStarted', mcp()), a);
  mapInteractionUpdate(mcpUpdate('toolCallCompleted', mcp({ query: argValue('docs') })), a);
  expect(commitCursorTools(a).find((p) => p.type === 'tool-call')).toMatchObject({
    toolCallId: 'outer',
    input: '{"query":"docs","limit":6}',
  });
});
