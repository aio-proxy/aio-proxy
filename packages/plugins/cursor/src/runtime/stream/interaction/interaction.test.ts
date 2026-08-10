import { expect, test } from 'bun:test';

import { create, toBinary } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';

import { InteractionUpdateSchema } from '../../../gen/agent_pb';
import { createCursorStreamAccumulator, finalizeCursorStream, mapInteractionUpdate } from './interaction';

const update = (value: Record<string, unknown>) => create(InteractionUpdateSchema, { message: value } as never);
const argValue = (json: unknown) =>
  toBinary(ValueSchema, create(ValueSchema, { kind: { case: 'stringValue', value: JSON.stringify(json) } }));

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
  const mcpUpdate = (
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
    ...mapInteractionUpdate(mcpUpdate('toolCallStarted', 'outer-a', 'nested-a', '/a'), accumulator),
    ...mapInteractionUpdate(mcpUpdate('toolCallStarted', 'outer-b', 'nested-b', '/b'), accumulator),
    ...mapInteractionUpdate(
      update({ case: 'partialToolCall', value: { callId: 'outer-a', argsTextDelta: '{"path":"/a"}' } }),
      accumulator,
    ),
    ...mapInteractionUpdate(
      update({ case: 'partialToolCall', value: { callId: 'outer-b', argsTextDelta: '{"path":"/b"}' } }),
      accumulator,
    ),
    ...mapInteractionUpdate(mcpUpdate('toolCallCompleted', 'outer-a', 'nested-a', '/a'), accumulator),
    ...mapInteractionUpdate(mcpUpdate('toolCallCompleted', 'outer-b', 'nested-b', '/b'), accumulator),
  ];
  const calls = parts.filter((part) => part.type === 'tool-call') as Array<{
    toolCallId: string;
    input: string;
  }>;

  expect(calls.map(({ toolCallId, input }) => [toolCallId, JSON.parse(input)])).toEqual([
    ['outer-a', { path: '/a' }],
    ['outer-b', { path: '/b' }],
  ]);
  expect([...accumulator.completedToolCalls]).toEqual([
    ['outer-a', 'nested-a'],
    ['outer-b', 'nested-b'],
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
  expect(accumulator.completedToolCalls.size).toBe(0);
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
