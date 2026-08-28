import { describe, expect, test } from 'bun:test';

import { sanitizeXAIGrokResponsesBody } from './sanitize-responses';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));

function buildBinaryRefFanOutParameters(depth: number): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  for (let index = 0; index <= depth; index += 1) {
    defs[`n_${index}`] =
      index === depth
        ? { type: 'object', properties: {} }
        : {
            type: 'object',
            properties: {
              a: { $ref: `#/$defs/n_${index + 1}` },
              b: { $ref: `#/$defs/n_${index + 1}` },
            },
          };
  }
  return {
    type: 'object',
    properties: { payload: { $ref: '#/$defs/n_0' } },
    $defs: defs,
  };
}

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

  test('quarantines one cyclic function and resets its named tool choice', () => {
    const cleaned = decode(
      sanitizeXAIGrokResponsesBody(
        encode({
          tools: [
            {
              type: 'function',
              name: 'broken',
              parameters: {
                type: 'object',
                oneOf: [{ $ref: '#/$defs/loop' }],
                $defs: { loop: { $ref: '#/$defs/loop' } },
              },
            },
            { type: 'function', name: 'healthy', parameters: { type: 'object', properties: {} } },
          ],
          tool_choice: { type: 'function', name: 'broken' },
        }),
      ),
    );

    expect(cleaned.tools).toEqual([
      { type: 'function', name: 'healthy', parameters: { type: 'object', properties: {} } },
    ]);
    expect(cleaned.tool_choice).toBe('auto');
  });

  test('sanitizes namespace and additional_tools catalogs and filters allowed_tools', () => {
    const unsafe = { type: 'function', name: 'unsafe', parameters: { oneOf: [{ type: 'string' }] } };
    const cleaned = decode(
      sanitizeXAIGrokResponsesBody(
        encode({
          tools: [
            {
              type: 'namespace',
              name: 'agents',
              tools: [unsafe, { type: 'function', name: 'spawn', parameters: { type: 'object' } }],
            },
          ],
          input: [
            {
              type: 'additional_tools',
              role: 'developer',
              tools: [unsafe, { type: 'custom', name: 'exec', format: { type: 'text' } }],
            },
            { role: 'user', content: 'continue' },
          ],
          tool_choice: {
            type: 'allowed_tools',
            mode: 'required',
            tools: [
              { type: 'function', name: 'unsafe' },
              { type: 'function', name: 'spawn' },
              { type: 'custom', name: 'exec' },
            ],
          },
        }),
      ),
    );

    expect(cleaned.tools[0].tools.map((tool: { name: string }) => tool.name)).toEqual(['spawn']);
    expect(cleaned.input[0].tools.map((tool: { name: string }) => tool.name)).toEqual(['exec']);
    expect(cleaned.tool_choice).toEqual({
      type: 'allowed_tools',
      mode: 'required',
      tools: [
        { type: 'function', name: 'spawn' },
        { type: 'custom', name: 'exec' },
      ],
    });
  });

  test('quarantines binary ref fan-out that exceeds the resolved-node budget', () => {
    const healthy = {
      type: 'function',
      name: 'healthy',
      parameters: { type: 'object', properties: { ok: { type: 'boolean' } } },
    };
    const startedAt = performance.now();
    const cleaned = decode(
      sanitizeXAIGrokResponsesBody(
        encode({
          tools: [
            {
              type: 'function',
              name: 'ref_fanout',
              parameters: buildBinaryRefFanOutParameters(20),
            },
            healthy,
          ],
        }),
      ),
    );
    const elapsedMs = performance.now() - startedAt;

    expect(cleaned.tools).toEqual([healthy]);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  test('keeps a property literally named definitions on an object schema', () => {
    const parameters = {
      type: 'object',
      properties: {
        definitions: { type: 'string' },
        keep: { type: 'string' },
      },
      required: ['definitions'],
      additionalProperties: false,
    };
    const cleaned = decode(
      sanitizeXAIGrokResponsesBody(
        encode({
          tools: [{ type: 'function', name: 'named_defs', parameters }],
        }),
      ),
    );

    expect(cleaned.tools[0].parameters).toEqual(parameters);
  });

  test('removes a required string tool choice when no tools remain', () => {
    const cleaned = decode(
      sanitizeXAIGrokResponsesBody(
        encode({
          tools: [{ type: 'function', name: 'broken', parameters: { $ref: 'https://example.test/schema' } }],
          tool_choice: 'required',
        }),
      ),
    );

    expect(cleaned).not.toHaveProperty('tools');
    expect(cleaned).not.toHaveProperty('tool_choice');
  });

  test('keeps a string tool choice when a valid catalog remains', () => {
    const healthy = {
      type: 'function',
      name: 'healthy',
      parameters: { type: 'object', properties: {} },
    };
    const cleaned = decode(
      sanitizeXAIGrokResponsesBody(
        encode({
          tools: [{ type: 'function', name: 'broken', parameters: { $ref: 'https://example.test/schema' } }, healthy],
          tool_choice: 'required',
        }),
      ),
    );

    expect(cleaned.tools).toEqual([healthy]);
    expect(cleaned.tool_choice).toBe('required');
  });

  test('removes empty catalogs and a forced choice when no tools remain', () => {
    const cleaned = decode(
      sanitizeXAIGrokResponsesBody(
        encode({
          tools: [
            {
              type: 'namespace',
              name: 'broken_namespace',
              tools: [{ type: 'function', name: 'broken', parameters: { $ref: 'https://example.test/schema' } }],
            },
          ],
          input: [
            {
              type: 'additional_tools',
              role: 'developer',
              tools: [{ type: 'function', name: 'broken', parameters: { type: 'string' } }],
            },
            { role: 'user', content: 'continue' },
          ],
          tool_choice: { type: 'function', name: 'broken' },
        }),
      ),
    );

    expect(cleaned).not.toHaveProperty('tools');
    expect(cleaned.input).toEqual([{ role: 'user', content: 'continue' }]);
    expect(cleaned).not.toHaveProperty('tool_choice');
  });
});
