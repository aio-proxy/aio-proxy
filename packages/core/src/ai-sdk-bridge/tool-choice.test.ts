import { expect, test } from 'bun:test';

import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { ProviderProtocol } from '@aio-proxy/types';

import { openAIResponsesAdapter } from '../protocol/openai-responses';
import { createAiSdkProvider } from '../provider/ai-sdk';
import { streamAiSdkText } from './index';

Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

/**
 * `ai` 7.0.9+ made `required` / named tool choices client-enforced: a model that
 * answers with text instead of a tool call raises `ToolChoiceViolationError`,
 * which the convert path would surface as a candidate failure while raw
 * passthrough kept returning the text. These tests pin the proxy's side of that
 * — forward the caller's intent, let the upstream decide — on the two boundaries
 * where the violation would otherwise land: the stream the bridge produces, and
 * the provider stream that turns an error part into a failed candidate.
 */

const TEXT_ONLY_ANSWER: readonly LanguageModelV2StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'plain answer' },
  { type: 'text-end', id: 'text-1' },
  {
    type: 'finish',
    finishReason: 'stop',
    usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
  },
];

function textOnlyModel(): { readonly model: LanguageModelV2; readonly calls: LanguageModelV2CallOptions[] } {
  const calls: LanguageModelV2CallOptions[] = [];
  const model = {
    specificationVersion: 'v2',
    provider: 'openai',
    modelId: 'gpt-5.6-terra',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('doGenerate should not be called');
    },
    async doStream(options: LanguageModelV2CallOptions) {
      calls.push(options);
      return {
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            for (const part of TEXT_ONLY_ANSWER) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  } satisfies LanguageModelV2;
  return { model, calls };
}

async function convertInvocation(toolChoice: unknown) {
  const parsed = await openAIResponsesAdapter.parse(
    new Request('https://proxy.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-terra',
        input: [{ role: 'user', content: 'What is in the file?' }],
        tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
        tool_choice: toolChoice,
      }),
    }),
    {},
  );
  return openAIResponsesAdapter.modelInvocationForTarget(
    openAIResponsesAdapter.modelInvocation(parsed, {}),
    ProviderProtocol.OpenAIResponse,
    new Set(),
  );
}

test('a required tool choice answered with text streams that text instead of a violation', async () => {
  const invocation = await convertInvocation('required');
  const { model, calls } = textOnlyModel();

  const result = streamAiSdkText({
    model,
    messages: invocation.messages,
    ...(invocation.settings === undefined ? {} : { settings: invocation.settings }),
    ...(invocation.tools === undefined ? {} : { tools: invocation.tools }),
  });
  const parts = [];
  for await (const part of result.fullStream) parts.push(part);

  expect(parts.filter((part) => part.type === 'error')).toEqual([]);
  expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.text)).toEqual(['plain answer']);
  // The caller's intent still reaches the provider, so the upstream request is
  // the same one it was before the SDK grew its own enforcement.
  expect(calls.map((call) => call.toolChoice)).toEqual([{ type: 'required' }]);
});

test('a named tool choice answered with text still forwards that tool to the provider', async () => {
  const invocation = await convertInvocation({ type: 'function', name: 'read_file' });
  const { model, calls } = textOnlyModel();

  const result = streamAiSdkText({
    model,
    messages: invocation.messages,
    ...(invocation.settings === undefined ? {} : { settings: invocation.settings }),
    ...(invocation.tools === undefined ? {} : { tools: invocation.tools }),
  });
  const parts = [];
  for await (const part of result.fullStream) parts.push(part);

  expect(parts.filter((part) => part.type === 'error')).toEqual([]);
  expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.text)).toEqual(['plain answer']);
  expect(calls.map((call) => call.toolChoice)).toEqual([{ type: 'tool', toolName: 'read_file' }]);
});

test('a required tool choice answered with text does not fail the candidate', async () => {
  const invocation = await convertInvocation('required');
  const { model } = textOnlyModel();
  const provider = createAiSdkProvider(
    { kind: 'ai-sdk', id: 'openai', packageName: '@ai-sdk/openai', models: ['gpt-5.6-terra'] },
    { resolveModel: () => model },
  );

  const parts = [];
  for await (const part of provider.invoke({
    messages: invocation.messages,
    modelId: 'gpt-5.6-terra',
    ...(invocation.settings === undefined ? {} : { settings: invocation.settings }),
    ...(invocation.tools === undefined ? {} : { tools: invocation.tools }),
  })) {
    parts.push(part);
  }

  expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.text)).toEqual(['plain answer']);
});
