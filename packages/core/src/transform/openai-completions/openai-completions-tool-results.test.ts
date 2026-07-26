import { describe, expect, test } from 'bun:test';

import type { OpenAICompletionsRequest } from '../../index';
import {
  OpenAICompletionsTransformError,
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

describe('OpenAI Completions transform', () => {
  test('emits every tool result as an ordered Chat message', () => {
    const converted = modelMessagesToOpenAICompletions({
      model: 'gpt-5.6-sol',
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_1',
              toolName: 'first',
              output: { type: 'text', value: 'first result' },
            },
            {
              type: 'tool-result',
              toolCallId: 'call_2',
              toolName: 'second',
              output: {
                type: 'content',
                value: [
                  {
                    type: 'file',
                    mediaType: 'image/png',
                    data: { type: 'data', data: 'AA==' },
                  },
                ],
              },
            },
          ],
        },
      ],
      settings: {},
    });

    expect(converted.messages).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'first result' },
      {
        role: 'tool',
        tool_call_id: 'call_2',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
      },
    ]);
  });

  test('rejects tool approval responses that Chat cannot encode', () => {
    expect(() =>
      modelMessagesToOpenAICompletions({
        model: 'gpt-5.6-sol',
        messages: [
          {
            role: 'tool',
            content: [{ type: 'tool-approval-response', approvalId: 'approval_1', approved: true }],
          },
        ],
        settings: {},
      }),
    ).toThrow(new OpenAICompletionsTransformError('messages.0.content.0.type'));
  });

  test('rejects a non-HTTP image_url instead of dropping it', () => {
    const request = parseOpenAICompletions({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///tmp/image.png' } }] }],
    });

    expect(() => openAICompletionsToModelMessages(request)).toThrow(
      new OpenAICompletionsTransformError('messages.0.content.0.image_url.url'),
    );
  });

  test('rejects an OpenAI file reference that Chat cannot encode', () => {
    expect(() =>
      modelMessagesToOpenAICompletions({
        model: 'gpt-5.6-sol',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                mediaType: 'image',
                data: { type: 'reference', reference: { openai: 'file_123' } },
              },
            ],
          },
        ],
        settings: {},
      }),
    ).toThrow(new OpenAICompletionsTransformError('messages.0.content.0.data'));
  });

  test('infers tool result names from preceding assistant tool calls', async () => {
    const request = await readFixture('valid-tool-message.json');

    const { messages } = openAICompletionsToModelMessages(request);

    expect(messages[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'lookup',
          output: { type: 'text', value: '{"ok":true}' },
        },
      ],
    });
  });

  test('maps developer messages to system messages', () => {
    const request = parseOpenAICompletions({
      model: 'gpt-5.5',
      messages: [
        { role: 'developer', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello!' },
      ],
    });

    expect(openAICompletionsToModelMessages(request).messages[0]).toEqual({
      role: 'system',
      content: 'You are a helpful assistant.',
    });
  });
});
