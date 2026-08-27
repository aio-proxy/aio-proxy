import { describe, expect, test } from 'bun:test';

import { sanitizeXAIGrokResponsesBody } from './sanitize-responses';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));

const capturedAutomationUpdateParameters = JSON.parse(
  `{"type":"object","properties":{},"oneOf":[{"$ref":"#/$defs/__schema0"},{"$ref":"#/$defs/__schema3"},{"$ref":"#/$defs/__schema21"},{"$ref":"#/$defs/__schema24"}],"$defs":{"__schema0":{"type":"object","properties":{"id":{"$ref":"#/$defs/__schema1"},"mode":{"type":"string","enum":["view"]}},"required":["mode","id"],"additionalProperties":false},"__schema1":{"$ref":"#/$defs/__schema2"},"__schema10":{"anyOf":[{"type":"string","enum":["failed_runs_only"]},{"type":"null"}]},"__schema11":{"type":"string","enum":["cron"]},"__schema12":{"anyOf":[{"$ref":"#/$defs/__schema13"},{"type":"null"}]},"__schema13":{"type":"string"},"__schema14":{"$ref":"#/$defs/__schema2"},"__schema15":{"type":"string","enum":["none","minimal","low","medium","high","xhigh","max","ultra"]},"__schema16":{"type":"string","enum":["create","suggested_create"]},"__schema17":{"type":"object","properties":{"destination":{"$ref":"#/$defs/__schema19"},"kind":{"$ref":"#/$defs/__schema18"},"mode":{"$ref":"#/$defs/__schema16"},"name":{"$ref":"#/$defs/__schema5"},"notificationPolicy":{"$ref":"#/$defs/__schema9"},"prompt":{"$ref":"#/$defs/__schema6"},"rrule":{"$ref":"#/$defs/__schema7"},"status":{"$ref":"#/$defs/__schema8"},"targetThreadId":{"$ref":"#/$defs/__schema20"}},"required":["name","prompt","rrule","status","kind","mode"],"additionalProperties":false},"__schema18":{"type":"string","enum":["heartbeat"]},"__schema19":{"type":"string","enum":["local","thread"]},"__schema2":{"type":"string"},"__schema20":{"$ref":"#/$defs/__schema2","type":"string"},"__schema21":{"oneOf":[{"type":"object","properties":{"destination":{"type":"string","enum":["local","worktree"]},"executionEnvironment":{"type":"string","enum":["worktree","local"]},"id":{"$ref":"#/$defs/__schema1"},"kind":{"$ref":"#/$defs/__schema11"},"localEnvironmentConfigPath":{"anyOf":[{"type":"string"},{"type":"null"}]},"mode":{"$ref":"#/$defs/__schema23"},"model":{"$ref":"#/$defs/__schema14"},"name":{"$ref":"#/$defs/__schema5"},"notificationPolicy":{"$ref":"#/$defs/__schema9"},"projectId":{"$ref":"#/$defs/__schema12"},"prompt":{"$ref":"#/$defs/__schema6"},"reasoningEffort":{"$ref":"#/$defs/__schema15"},"rrule":{"$ref":"#/$defs/__schema22"},"status":{"$ref":"#/$defs/__schema8"}},"required":["name","prompt","rrule","status","kind","projectId","model","reasoningEffort","mode","id","executionEnvironment"],"additionalProperties":false},{"type":"object","properties":{"destination":{"$ref":"#/$defs/__schema19"},"id":{"$ref":"#/$defs/__schema1"},"kind":{"$ref":"#/$defs/__schema18"},"mode":{"$ref":"#/$defs/__schema23"},"name":{"$ref":"#/$defs/__schema5"},"notificationPolicy":{"$ref":"#/$defs/__schema9"},"prompt":{"$ref":"#/$defs/__schema6"},"rrule":{"$ref":"#/$defs/__schema22"},"status":{"$ref":"#/$defs/__schema8"},"targetThreadId":{"$ref":"#/$defs/__schema20"}},"required":["name","prompt","rrule","status","kind","mode","id"],"additionalProperties":false}]},"__schema22":{"$ref":"#/$defs/__schema2"},"__schema23":{"type":"string","enum":["update","suggested_update"]},"__schema24":{"type":"object","properties":{"id":{"$ref":"#/$defs/__schema1"},"mode":{"type":"string","enum":["delete"]}},"required":["mode","id"],"additionalProperties":false},"__schema3":{"oneOf":[{"$ref":"#/$defs/__schema4"},{"$ref":"#/$defs/__schema17"}]},"__schema4":{"type":"object","properties":{"destination":{"type":"string","enum":["local"]},"executionEnvironment":{"type":"string","enum":["local"]},"kind":{"$ref":"#/$defs/__schema11"},"mode":{"$ref":"#/$defs/__schema16"},"model":{"$ref":"#/$defs/__schema14"},"name":{"$ref":"#/$defs/__schema5"},"notificationPolicy":{"$ref":"#/$defs/__schema9"},"projectId":{"$ref":"#/$defs/__schema12"},"prompt":{"$ref":"#/$defs/__schema6"},"reasoningEffort":{"$ref":"#/$defs/__schema15"},"rrule":{"$ref":"#/$defs/__schema7"},"status":{"$ref":"#/$defs/__schema8"}},"required":["name","prompt","rrule","status","kind","projectId","model","reasoningEffort","mode","executionEnvironment"],"additionalProperties":false},"__schema5":{"$ref":"#/$defs/__schema2"},"__schema6":{"$ref":"#/$defs/__schema2"},"__schema7":{"$ref":"#/$defs/__schema2"},"__schema8":{"type":"string","enum":["ACTIVE","PAUSED"]},"__schema9":{"$ref":"#/$defs/__schema10"}}}`,
) as Record<string, unknown>;

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

  test('keeps the captured Codex automation tool as six explicit object branches', () => {
    const ordinary = {
      type: 'function',
      name: 'exec_command',
      strict: true,
      parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
    };
    const cleaned = decode(
      sanitizeXAIGrokResponsesBody(
        encode({
          tools: [
            {
              type: 'function',
              name: 'mcp__codex_app__automation_update',
              strict: false,
              parameters: capturedAutomationUpdateParameters,
            },
            ordinary,
          ],
        }),
      ),
    );

    const parameters = cleaned.tools[0].parameters as Record<string, unknown>;
    const branches = parameters.oneOf as Array<Record<string, unknown>>;
    expect(cleaned.tools[0].strict).toBe(false);
    expect(branches).toHaveLength(6);
    expect(branches.every((branch) => branch.type === 'object')).toBe(true);
    expect(JSON.stringify(parameters)).not.toContain('$ref');
    expect(parameters).not.toHaveProperty('$defs');
    expect(branches.map((branch) => (branch.properties as Record<string, unknown>).mode)).toEqual([
      { type: 'string', enum: ['view'] },
      { type: 'string', enum: ['create', 'suggested_create'] },
      { type: 'string', enum: ['create', 'suggested_create'] },
      { type: 'string', enum: ['update', 'suggested_update'] },
      { type: 'string', enum: ['update', 'suggested_update'] },
      { type: 'string', enum: ['delete'] },
    ]);
    expect(cleaned.tools[1]).toEqual(ordinary);
  });

  test('leaves invalid JSON unchanged', () => {
    const original = new TextEncoder().encode('{not-json');
    expect(sanitizeXAIGrokResponsesBody(original)).toEqual(original);
  });
});
