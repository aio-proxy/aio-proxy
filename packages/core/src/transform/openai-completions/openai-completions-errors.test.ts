import { describe, expect, test } from 'bun:test';

import type { OpenAICompletionsRequest } from '../../index';
import { openAICompletionsToModelMessages } from '../../index';

describe('OpenAI Completions transform', () => {
  test('throws field path when tool call function name is missing', () => {
    const request = {
      model: 'gpt-5-mini',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_missing',
              type: 'function',
              function: {
                arguments: '{}',
              },
            },
          ],
        },
      ],
    };

    expect(() => openAICompletionsToModelMessages(request as OpenAICompletionsRequest)).toThrow(
      'messages.0.tool_calls.0.function.name',
    );
  });
});
