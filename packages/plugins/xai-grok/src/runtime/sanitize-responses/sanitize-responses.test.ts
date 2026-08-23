import { describe, expect, test } from 'bun:test';

import { sanitizeXAIGrokResponsesBody } from './sanitize-responses';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));

describe('sanitizeXAIGrokResponsesBody', () => {
  test('drops Codex Desktop fields that cli-chat-proxy rejects', () => {
    const cleaned = decode(
      sanitizeXAIGrokResponsesBody(
        encode({
          model: 'grok-4.6',
          previous_response_id: 'resp_old',
          prompt_cache_retention: '24h',
          safety_identifier: 'user',
          stream_options: { include_obfuscation: true },
          stop: ['END'],
          reasoning: { effort: 'high', summary: 'auto' },
          keep: true,
        }),
      ),
    );
    expect(cleaned).toEqual({
      model: 'grok-4.6',
      reasoning: { effort: 'high' },
      keep: true,
    });
  });

  test('simplifies Codex automation_update schemas', () => {
    const cleaned = decode(
      sanitizeXAIGrokResponsesBody(
        encode({
          model: 'grok-4.6',
          tools: [
            {
              type: 'namespace',
              name: 'codex_app',
              tools: [
                {
                  type: 'function',
                  name: 'automation_update',
                  strict: true,
                  parameters: { oneOf: [{ type: 'object' }, { type: 'null' }] },
                },
              ],
            },
            {
              type: 'function',
              name: 'codex_app__automation_update',
              strict: true,
              parameters: { anyOf: [{ type: 'object' }, { type: 'null' }] },
            },
            {
              type: 'function',
              name: 'exec_command',
              strict: true,
              parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
            },
          ],
        }),
      ),
    );
    const safe = { type: 'object', properties: {}, additionalProperties: true };
    expect(cleaned.tools[0].tools[0]).toMatchObject({ parameters: safe, strict: false });
    expect(cleaned.tools[1]).toMatchObject({ parameters: safe, strict: false });
    expect(cleaned.tools[2].parameters).toEqual({
      type: 'object',
      properties: { cmd: { type: 'string' } },
    });
  });

  test('leaves a top-level automation_update tool unchanged', () => {
    const tool = {
      type: 'function',
      name: 'automation_update',
      strict: true,
      parameters: { type: 'object', properties: { cron: { type: 'string' } } },
    };
    const cleaned = decode(sanitizeXAIGrokResponsesBody(encode({ tools: [tool] })));

    expect(cleaned.tools).toEqual([tool]);
  });

  test('leaves invalid JSON unchanged', () => {
    const original = new TextEncoder().encode('{not-json');
    expect(sanitizeXAIGrokResponsesBody(original)).toEqual(original);
  });
});
