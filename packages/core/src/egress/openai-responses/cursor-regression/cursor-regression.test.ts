import { expect, test } from 'bun:test';

import type { CredentialPort } from '@aio-proxy/plugin-sdk';

import { createCursorLanguageModel } from '../../../../../plugins/cursor/src/runtime/cursor-model';
import {
  createProtocolFixture,
  protocolServerFrame,
  protocolUpdateFrame,
} from '../../../../../plugins/cursor/src/runtime/cursor-model/test-support';
import type { CursorCredential } from '../../../../../plugins/cursor/src/schema';
import { CursorSessionStore } from '../../../../../plugins/cursor/src/store/session-store';
import { jsonSchema, streamAiSdkText, type ModelMessage } from '../../../ai-sdk-bridge';
import { writeOpenAIResponsesSSE } from '../index';

const credentials: CredentialPort<CursorCredential> = {
  read: async () => ({
    value: {
      accessToken: 'test',
      refreshToken: 'test',
      expiresAt: Number.MAX_SAFE_INTEGER,
      subject: 'test-account',
    },
    revision: 0,
  }),
  refresh: async () => {
    throw new Error('unexpected refresh');
  },
};

type OutputCall = { id: string; type: string; call_id: string; name: string; arguments: string };
type Event = {
  type: string;
  item_id?: string;
  delta?: string;
  arguments?: string;
  item?: OutputCall;
  response?: { output: OutputCall[] };
};

test('Cursor MCP inputs survive the actual AI SDK and Responses SSE in both turns', async () => {
  const argsBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const toolUpdate = (event: string, id: string, args: Record<string, Uint8Array>, delta?: string) =>
    protocolUpdateFrame({
      case: event,
      value: {
        callId: 'outer-' + id,
        ...(delta === undefined ? {} : { argsTextDelta: delta }),
        toolCall: {
          tool: {
            case: 'mcpToolCall',
            value: {
              args: { name: 'search', toolName: 'search', toolCallId: 'nested-' + id, args },
            },
          },
        },
      },
    });
  const f = createProtocolFixture([
    [
      toolUpdate('toolCallStarted', 'a', {}),
      toolUpdate('partialToolCall', 'a', {}, '{"query":"alpha","limit":6,"filters":{"lang":"ts"}}'),
      toolUpdate('toolCallCompleted', 'a', { query: argsBytes('alpha'), filters: argsBytes('degraded') }),
      toolUpdate('toolCallStarted', 'b', {}),
      protocolServerFrame({
        case: 'execServerMessage',
        value: {
          id: 2,
          execId: 'exec-b',
          message: {
            case: 'mcpArgs',
            value: {
              name: 'search',
              toolName: 'search',
              toolCallId: 'nested-b',
              args: { query: argsBytes('beta') },
            },
          },
        },
      }),
      // 第一轮没有 checkpoint、turnEnded、END_STREAM；由完整批次交接结束。
    ],
    [
      protocolUpdateFrame({ case: 'textDelta', value: { text: 'Both results received.' } }),
      { flags: 2, payload: new TextEncoder().encode('{}') },
      // 第二轮 HTTP 保持打开；Connect 成功本身应完成响应。
    ],
  ]);
  const model = createCursorLanguageModel('composer-2', {
    credentials,
    transport: f.transport,
    sessionStore: new CursorSessionStore(),
    model: { wireModelId: 'composer-2', displayModelId: 'composer-2', displayName: 'Composer 2', maxMode: false },
  });
  const tools = {
    search: {
      inputSchema: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number' }, filters: { type: 'object' } },
        required: ['query'],
      }),
    },
  };
  const responses = async (messages: ModelMessage[]): Promise<Event[]> => {
    const { fullStream } = streamAiSdkText({
      model,
      messages,
      tools,
      settings: {
        maxRetries: 0,
        providerOptions: {
          aioProxy: {
            logicalRequest: {
              requestId: 'integration-1',
              session: { key: 'sha256:integration', source: 'body-conversation' },
            },
          },
        },
      },
    });
    const sse = writeOpenAIResponsesSSE(fullStream, { modelId: 'composer-2' });
    const [body] = await Promise.all([new Response(sse).text(), sse.completion]);
    return body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)) as Event);
  };
  const user: ModelMessage = { role: 'user', content: 'Compare alpha and beta.' };
  const first = await responses([user]);
  expect(first.filter((e) => e.type === 'response.completed')).toHaveLength(1);
  expect(first.some((e) => e.type === 'response.failed')).toBe(false);
  const output = first
    .find((e) => e.type === 'response.completed')!
    .response!.output.filter((item) => item.type === 'function_call');
  expect(output.map((c) => c.call_id)).toEqual(['outer-a', 'outer-b']);
  expect(output.map((c) => JSON.parse(c.arguments))).toEqual([
    { query: 'alpha', limit: 6, filters: { lang: 'ts' } },
    { query: 'beta' },
  ]);
  for (const call of output) {
    const delta = first.filter((e) => e.type === 'response.function_call_arguments.delta' && e.item_id === call.id);
    const done = first.filter((e) => e.type === 'response.function_call_arguments.done' && e.item_id === call.id);
    const itemDone = first.filter((e) => e.type === 'response.output_item.done' && e.item?.id === call.id);
    expect(delta).toHaveLength(1);
    expect(delta.map((e) => e.delta).join('')).toBe(call.arguments);
    expect(done).toHaveLength(1);
    expect(done[0]!.arguments).toBe(call.arguments);
    expect(itemDone).toHaveLength(1);
    expect(itemDone[0]!.item!.arguments).toBe(call.arguments);
  }
  const second = await responses([
    user,
    {
      role: 'assistant',
      content: output.map((call) => ({
        type: 'tool-call',
        toolCallId: call.call_id,
        toolName: call.name,
        input: JSON.parse(call.arguments),
      })),
    },
    {
      role: 'tool',
      content: output.map((call, i) => ({
        type: 'tool-result',
        toolCallId: call.call_id,
        toolName: call.name,
        output: { type: 'text', value: i === 0 ? 'RESULT_A' : 'RESULT_B' },
      })),
    },
  ]);
  expect(second.filter((e) => e.type === 'response.completed')).toHaveLength(1);
  const root = f.roots[1]!.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const calls = root.filter((p) => p.type === 'tool-call');
  const results = root.filter((p) => p.type === 'tool-result');
  expect(calls.map((c) => c.args)).toEqual(output.map((c) => JSON.parse(c.arguments)));
  expect(results.map((r) => r.result)).toEqual(['RESULT_A', 'RESULT_B']);
  expect(results.map((r) => r.toolCallId)).toEqual(calls.map((c) => c.toolCallId));
  expect(f.runs).toHaveLength(2);
  expect(f.closes).toEqual([1, 1]);
});
