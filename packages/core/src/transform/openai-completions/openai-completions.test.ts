import { describe, expect, test } from 'bun:test';

import type { OpenAICompletionsRequest } from '../../index';
import {
  modelMessagesToOpenAICompletions,
  openAICompletionsToModelMessages,
  parseOpenAICompletions,
} from '../../index';

const fixtureRoot = `${import.meta.dir}/../../../__tests__/fixtures/openai-completions`;

const validFixtures = [
  'valid-basic.json',
  'valid-system-user.json',
  'valid-content-parts.json',
  'valid-tool-call.json',
  'valid-tool-message.json',
  'valid-options.json',
] as const;

type FixtureFile = (typeof validFixtures)[number];

async function readFixture(file: FixtureFile): Promise<OpenAICompletionsRequest> {
  return parseOpenAICompletions(await Bun.file(`${fixtureRoot}/${file}`).json());
}

function expectedRoundTrip(request: OpenAICompletionsRequest): OpenAICompletionsRequest {
  return {
    ...request,
    tool_choice: undefined,
    max_tokens: undefined,
    max_completion_tokens: request.max_completion_tokens ?? request.max_tokens ?? undefined,
    messages: request.messages.map((message) =>
      Array.isArray(message.content)
        ? { ...message, content: message.content.filter((part) => part.type === 'text' || part.type === 'image_url') }
        : message,
    ),
  };
}

describe('OpenAI Completions transform', () => {
  for (const file of validFixtures) {
    test(`round-trips ${file}`, async () => {
      const request = await readFixture(file);

      const converted = openAICompletionsToModelMessages(request);
      const roundTrip = modelMessagesToOpenAICompletions({
        model: request.model,
        ...converted,
      });

      expect(roundTrip).toEqual(expectedRoundTrip(request));
    });
  }

  test('preserves conventional user image_url parts', async () => {
    const request = await readFixture('valid-content-parts.json');
    const converted = openAICompletionsToModelMessages(request);

    expect(converted.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image.' },
        {
          type: 'file',
          mediaType: 'image/png',
          data: { type: 'url', url: new URL('https://example.com/image.png') },
        },
      ],
    });
    expect(modelMessagesToOpenAICompletions({ model: request.model, ...converted }).messages[0]?.content).toEqual(
      request.messages[0]?.content,
    );
  });

  test('preserves ordered CPA image_url parts in tool content', () => {
    const request = parseOpenAICompletions({
      model: 'gpt-5.6-sol',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'inspect', arguments: '{}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: [
            { type: 'text', text: 'before' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'high' } },
            { type: 'text', text: 'after' },
          ],
        },
      ],
    });

    const converted = openAICompletionsToModelMessages(request);
    expect(converted.messages[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'inspect',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: 'before' },
              {
                type: 'file',
                mediaType: 'image/png',
                data: { type: 'data', data: 'AA==' },
                providerOptions: {
                  openai: { imageDetail: 'high' },
                  aioProxy: { toolImage: true, trust: expect.any(String) },
                },
              },
              { type: 'text', text: 'after' },
            ],
          },
        },
      ],
    });
    expect(modelMessagesToOpenAICompletions({ model: request.model, ...converted }).messages[1]).toEqual(
      request.messages[1],
    );
  });
});
