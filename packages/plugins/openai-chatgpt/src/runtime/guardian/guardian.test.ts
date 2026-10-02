import { expect, spyOn, test } from 'bun:test';

import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';

import { createOpenAIChatGPTPlugin, englishPresentationText } from '../../plugin/plugin';
import { guardianDecision } from './decision';
import { guardianRequest as fixtureGuardianRequest, syntheticGuardianInput } from './fixture';
import { createGuardianPreRouteInvoke, createGuardianRawInvoke } from './guardian';
import { guardianQuestions } from './questions';
import { guardianPayloadHint, projectGuardianRequest } from './request';
import { guardianResponse } from './response';

function guardianRequest(input: readonly unknown[]): Request {
  const visibleInput = structuredClone(input) as Record<string, unknown>[];
  for (const item of visibleInput) {
    if (item['type'] === 'reasoning') delete item['encrypted_content'];
  }
  return fixtureGuardianRequest(visibleInput);
}

const visibleGuardianInput = structuredClone(syntheticGuardianInput) as Record<string, unknown>[];
delete visibleGuardianInput[4]!['encrypted_content'];

test('setup closes the wrapper over schema-parsed options', async () => {
  let registered: Function | undefined;
  let preRouteRegistered: Function | undefined;
  const plugin = createOpenAIChatGPTPlugin(englishPresentationText);
  await plugin.setup(
    {
      oauth: { register() {} },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      raw: {
        register(_protocol: 'openai-response', phase: 'wrap' | 'pre-route', hook: Function) {
          if (phase === 'wrap') registered = hook;
          else preRouteRegistered = hook;
        },
      },
    } as never,
    {},
  );
  const calls: string[] = [];
  const invoke = registered!({
    original: async () => {
      calls.push('original');
      return new Response();
    },
    evaluate: async () => {
      calls.push('evaluate');
      return {};
    },
  });
  await invoke(new Request('http://localhost/v1/responses'), undefined, { upstreamStream: false });
  expect(calls).toEqual(['original']);
  expect(preRouteRegistered).toBeFunction();
});

test('preserves complete inline decision evidence and original request', async () => {
  const original = guardianRequest(syntheticGuardianInput);
  const body = await original.clone().json();
  const projection = await projectGuardianRequest(original);
  expect(projection?.state.input).toEqual(body.input);
  expect(projection?.state.pending_action).toEqual({
    tool: 'exec_command',
    command: ['bun', 'test'],
    cwd: '/workspace',
    justification: 'Run the requested tests',
    sandbox_permissions: 'use_default',
    tty: false,
  });
  expect(projection?.stream).toBe(true);
  expect(await original.json()).toEqual(body);
});

test('requires visible developer policy text and preserves supplementary instructions', async () => {
  const firstWrapper = (await guardianRequest(syntheticGuardianInput).json()) as any;
  firstWrapper.input[0].content = [{ type: 'input_text', text: ' \n ' }];
  expect(
    await projectGuardianRequest(
      new Request('https://example.test/v1/responses', {
        method: 'POST',
        body: JSON.stringify(firstWrapper),
      }),
    ),
  ).toBeUndefined();

  const secondWrapper = (await guardianRequest(syntheticGuardianInput).json()) as any;
  secondWrapper.input.splice(1, 0, {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: '<permissions instructions>\n</permissions instructions>' }],
  });
  expect(
    await projectGuardianRequest(
      new Request('https://example.test/v1/responses', {
        method: 'POST',
        body: JSON.stringify(secondWrapper),
      }),
    ),
  ).toBeDefined();
});

const cases: [string, (body: any) => void][] = [
  [
    'nested metadata reference',
    (b) => {
      b.input[1].metadata = { source: { file_id: 'missing-file' } };
    },
  ],
  [
    'missing marker',
    (b) => {
      delete b.client_metadata;
    },
  ],
  [
    'nested enum',
    (b) => {
      b.text.format.schema = { type: 'object', properties: { nested: b.text.format.schema } };
    },
  ],
  [
    'extra required property',
    (b) => {
      b.text.format.schema.required.push('rationale');
    },
  ],
  [
    'additional properties',
    (b) => {
      b.text.format.schema.additionalProperties = true;
    },
  ],
  [
    'schema restriction',
    (b) => {
      b.text.format.schema.properties.rationale.minLength = 100;
    },
  ],
  [
    'previous response',
    (b) => {
      b.previous_response_id = 'previous';
    },
  ],
  [
    'conversation',
    (b) => {
      b.conversation = 'conversation';
    },
  ],
  [
    'instructions',
    (b) => {
      b.instructions = 'hidden policy';
    },
  ],
  [
    'unknown context',
    (b) => {
      b.context = { id: 'hidden' };
    },
  ],
  [
    'nested file reference',
    (b) => {
      b.input[1].content.push({ type: 'input_file', file_id: 'file-1' });
    },
  ],
  [
    'encoded context',
    (b) => {
      b.input.splice(1, 0, { type: 'compaction', encrypted_content: 'needed-context' });
    },
  ],
  [
    'policy from tool output',
    (b) => {
      b.input[3].output = b.input[0].content[0].text;
      b.input.shift();
    },
  ],
  [
    'duplicate envelope',
    (b) => {
      b.input.at(-1).content.push(...b.input.at(-1).content.slice(-4));
    },
  ],
  [
    'trailing text',
    (b) => {
      b.input.at(-1).content.push({ type: 'input_text', text: 'after' });
    },
  ],
  [
    'no terminal envelope',
    (b) => {
      b.input.pop();
    },
  ],
  [
    'current assistant review history',
    (b) => {
      b.input.splice(
        -1,
        0,
        {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: '{"outcome":"deny"}' }],
        },
        {
          type: 'message',
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: 'Review this later round using the original policy.',
            },
          ],
        },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '>>> APPROVAL REQUEST START' },
            { type: 'input_text', text: 'Assess the exact planned action below.' },
            { type: 'input_text', text: 'Planned action JSON:' },
            { type: 'input_text', text: '{"tool":"old"}' },
            { type: 'input_text', text: '>>> APPROVAL REQUEST END' },
          ],
        },
      );
      const content = b.input.at(-1).content;
      content.splice(-3, 0, { type: 'input_text', text: 'Assess the exact planned action below.' });
    },
  ],
  [
    'nonobject action',
    (b) => {
      b.input.at(-1).content.at(-2).text = '[]';
    },
  ],
];
test('preserves complete supplementary developer policy within the request body limit', async () => {
  for (const text of ['x'.repeat(1_001)]) {
    const body = await guardianRequest(syntheticGuardianInput).json();
    body.input.splice(1, 0, { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
    expect(
      await projectGuardianRequest(
        new Request('https://example.test/v1/responses', { method: 'POST', body: JSON.stringify(body) }),
      ),
    ).toMatchObject({ state: { input: body.input } });
  }
});

test('preserves empty supplementary developer messages without dropping visible policy evidence', async () => {
  const body = await guardianRequest(syntheticGuardianInput).json();
  body.input.splice(1, 0, {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: ' \n ' }],
  });
  const request = new Request('https://example.test/v1/responses', { method: 'POST', body: JSON.stringify(body) });
  expect((await projectGuardianRequest(request))?.state.input).toEqual(body.input);
});

test('accepts a paired custom tool call in Guardian history', async () => {
  const body = await guardianRequest(syntheticGuardianInput).json();
  body.input.splice(
    -1,
    0,
    {
      type: 'custom_tool_call',
      id: 'custom-call',
      status: 'completed',
      call_id: 'call-custom',
      name: 'exec',
      input: 'const result = await tools.exec_command({ cmd: "git status" });',
    },
    {
      type: 'custom_tool_call_output',
      id: 'custom-output',
      call_id: 'call-custom',
      output: [{ type: 'input_text', text: 'clean' }],
    },
  );
  const projection = await projectGuardianRequest(
    new Request('https://example.test/v1/responses', { method: 'POST', body: JSON.stringify(body) }),
  );
  expect(projection?.state.pending_action.tool).toBe('exec_command');
});

test('accepts current Codex review history and the assessed terminal action', async () => {
  const body = await guardianRequest(syntheticGuardianInput).json();
  const change = cases.find(([name]) => name === 'current assistant review history')?.[1];
  change(body);
  const projection = await projectGuardianRequest(
    new Request('https://example.test/v1/responses', { method: 'POST', body: JSON.stringify(body) }),
  );
  expect(projection?.state.pending_action).toEqual({
    tool: 'exec_command',
    command: ['bun', 'test'],
    cwd: '/workspace',
    justification: 'Run the requested tests',
    sandbox_permissions: 'use_default',
    tty: false,
  });
});

for (const [name, change] of cases.filter(([name]) => name !== 'current assistant review history'))
  test(`bypasses ${name} before disclosure`, async () => {
    const body = await guardianRequest(syntheticGuardianInput).json();
    change(body);
    expect(
      await projectGuardianRequest(
        new Request('https://example.test/v1/responses', { method: 'POST', body: JSON.stringify(body) }),
      ),
    ).toBeUndefined();
  });

test('matches guardian on any resolved model and exact creation transport', async () => {
  const other = guardianRequest(syntheticGuardianInput);
  expect((await projectGuardianRequest(other))?.state.input).toEqual(visibleGuardianInput);
  expect(await other.text()).toContain('"model":"codex-auto-review"');
  for (const path of ['/v1/responses/compact', '/v1/responses/']) {
    const body = await guardianRequest(syntheticGuardianInput).text();
    expect(
      await projectGuardianRequest(new Request(`https://example.test${path}`, { method: 'POST', body })),
    ).toBeUndefined();
  }
  expect(await projectGuardianRequest(new Request('https://example.test/v1/responses'))).toBeUndefined();
});

test('bypasses oversized or malformed bodies without consuming original', async () => {
  for (const body of ['{', 'x'.repeat(1_048_577)]) {
    const original = new Request('https://example.test/v1/responses', { method: 'POST', body });
    expect(await projectGuardianRequest(original)).toBeUndefined();
    expect(await original.text()).toBe(body);
  }
});

test('accepts schema annotation and property order changes', async () => {
  const body = await guardianRequest(syntheticGuardianInput).json();
  body.stream = false;
  body.text.format.schema.description = 'Synthetic decision';
  body.text.format.schema.properties = Object.fromEntries(Object.entries(body.text.format.schema.properties).reverse());
  body.text.format.schema.properties.outcome.description = 'Decision';
  const request = new Request('https://example.test/v1/responses', { method: 'POST', body: JSON.stringify(body) });
  expect((await projectGuardianRequest(request))?.stream).toBe(false);
});

test('preserves custom policy wording and rules without a text profile', async () => {
  for (const policy of [
    'Review the action under this custom workspace policy. Deny low-risk writes without explicit authorization.',
    syntheticGuardianInput[0]!.content![0]!.text!.replace(
      'Deny critical risk.',
      'Allow critical risk with explicit reapproval.',
    ),
  ]) {
    const input = structuredClone(syntheticGuardianInput);
    input[0]!.content![0]!.text = policy;
    const expected = structuredClone(input) as Record<string, unknown>[];
    delete expected[4]!['encrypted_content'];
    expect((await projectGuardianRequest(guardianRequest(input)))?.state.input).toEqual(expected);
  }
});

for (const index of [1, 2, 3, 4]) {
  for (const [field, value] of [
    ['status', 'incomplete'],
    ['status', 'in_progress'],
    ['status', { file_id: 'missing-evidence' }],
    ['id', { file_id: 'missing-evidence' }],
    ['id', null],
    ['id', ''],
  ]) {
    test(`rejects malformed ${String(field)}=${JSON.stringify(value)} on ${syntheticGuardianInput[index]!.type}`, async () => {
      const input = structuredClone(syntheticGuardianInput);
      Object.assign(input[index]!, { [String(field)]: value });
      expect(await projectGuardianRequest(guardianRequest(input))).toBeUndefined();
    });
  }
}

test('preserves completed items with optional string IDs', async () => {
  const input = syntheticGuardianInput.map((item, index) => ({ ...item, id: `item-${index}`, status: 'completed' }));
  const expected = structuredClone(input) as Record<string, unknown>[];
  delete expected[4]!['encrypted_content'];
  expect((await projectGuardianRequest(guardianRequest(input)))?.state.input).toEqual(expected);
});

const guardianLabels = {
  risk_level: ['low', 'medium', 'high', 'critical'],
  user_authorization: ['unknown', 'low', 'medium', 'high'],
  outcome: ['allow', 'deny', 'uncertain'],
} as const;

function choiceResult(risk: string, authorization: string, outcome: string): any {
  const selected = { risk_level: risk, user_authorization: authorization, outcome };
  return {
    answers: Object.fromEntries(
      Object.entries(guardianLabels).map(([id, labels]) => [
        id,
        {
          type: 'choice',
          choice: selected[id as keyof typeof selected],
          probabilities: Object.fromEntries(
            labels.map((label) => [label, label === selected[id as keyof typeof selected] ? 1 : 0]),
          ),
        },
      ]),
    ),
  };
}

test('asks policy-driven questions without adding risk or authorization outcome rules', () => {
  const questions = guardianQuestions();
  expect(Object.keys(questions)).toEqual(['risk_level', 'user_authorization', 'outcome']);
  for (const question of Object.values(questions)) {
    expect(question.instructions).toContain('state.input');
    expect(question.instructions).toContain('developer');
    expect(question.instructions).toContain('tool output');
    expect(question.instructions).toContain('quoted role labels');
    expect(question.instructions).not.toContain('cannot permit critical risk');
    expect(question.instructions).not.toContain('Only human');
  }
  expect(questions.outcome.criteria.uncertain).toContain('policy');
});

test('preserves policy outcomes independently of risk and authorization classifications', async () => {
  const projection = (await projectGuardianRequest(guardianRequest(syntheticGuardianInput)))!;
  for (const [risk, authorization, outcome] of [
    ['low', 'unknown', 'allow'],
    ['low', 'high', 'deny'],
    ['medium', 'low', 'allow'],
    ['high', 'unknown', 'allow'],
    ['high', 'high', 'deny'],
    ['critical', 'unknown', 'allow'],
    ['critical', 'high', 'deny'],
  ]) {
    const decision = guardianDecision(choiceResult(risk!, authorization!, outcome!), projection);
    expect(decision).toMatchObject({ outcome });
    if (risk !== 'low' || outcome !== 'allow') {
      expect(decision).toMatchObject({ risk_level: risk, user_authorization: authorization });
      expect(decision?.rationale).toBe(
        outcome === 'allow'
          ? 'The supplied Guardian policy assessment permits this action.'
          : 'The supplied Guardian policy assessment denies this action.',
      );
    }
  }
});

test('rejects uncertainty, malformed classifications and incomplete probability distributions', async () => {
  const projection = (await projectGuardianRequest(guardianRequest(syntheticGuardianInput)))!;
  expect(guardianDecision(choiceResult('low', 'unknown', 'uncertain'), projection)).toBeUndefined();
  const valid = choiceResult('low', 'low', 'allow');
  for (const [id, labels] of Object.entries(guardianLabels)) {
    const first = labels[0]!;
    for (const mutate of [
      (r: any) => {
        delete r.answers[id];
      },
      (r: any) => {
        r.answers.extra = r.answers[id];
      },
      (r: any) => {
        r.answers[id].type = 'score';
      },
      (r: any) => {
        r.answers[id].choice = 'other';
      },
      (r: any) => {
        delete r.answers[id].probabilities[first];
      },
      (r: any) => {
        r.answers[id].probabilities.other = 0;
      },
      ...[-0.1, 1.1, NaN, Infinity, null, '0.5'].map((value) => (r: any) => {
        r.answers[id].probabilities[first] = value;
      }),
    ]) {
      const malformed = structuredClone(valid);
      mutate(malformed);
      expect(guardianDecision(malformed, projection)).toBeUndefined();
    }
  }
  expect(
    guardianDecision(valid, { ...projection, schema: { ...projection.schema, required: ['outcome', 'rationale'] } }),
  ).toBeUndefined();
});

test('returns one completed Guardian decision in a JSON Responses envelope', async () => {
  const response = guardianResponse({ outcome: 'allow' }, false, 'gpt-6-sol');
  expect(response.headers.get('Content-Type')).toContain('application/json');
  const body = await response.json();
  expect(body.model).toBe('gpt-6-sol');
  expect(body.object).toBe('response');
  expect(body.status).toBe('completed');
  expect(body.id).toMatch(/^resp_[0-9a-f-]+$/);
  expect(body.output).toHaveLength(1);
  expect(body.output[0]).toMatchObject({ type: 'message', role: 'assistant', status: 'completed' });
  expect(body.output[0].id).toMatch(/^msg_[0-9a-f-]+$/);
  expect(body.output[0].content).toEqual([
    { type: 'output_text', text: '{"outcome":"allow"}', annotations: [], logprobs: [] },
  ]);
  expect(body.output_text).toBe('{"outcome":"allow"}');
  expect(body.completed_at).toBe(body.created_at);
  expect(body).not.toHaveProperty('usage');
  // Codex's text consumer reads the assistant item's output_text.
  expect(JSON.parse(body.output[0].content[0].text)).toEqual({ outcome: 'allow' });
});

test('streams one completed Guardian decision with coherent Responses events', async () => {
  const response = guardianResponse({ outcome: 'allow' }, true, 'gpt-6-sol');
  expect(response.headers.get('Content-Type')).toContain('text/event-stream');
  const frames = (await response.text()).trim().split('\n\n');
  const events = frames.map((frame) => {
    const [eventLine, dataLine] = frame.split('\n');
    const event = JSON.parse(dataLine!.slice('data: '.length));
    expect(eventLine).toBe(`event: ${event.type}`);
    return event;
  });
  expect(events.map((event) => event.type)).toEqual([
    'response.created',
    'response.output_item.added',
    'response.output_text.delta',
    'response.output_item.done',
    'response.completed',
  ]);
  expect(events.map((event) => event.sequence_number)).toEqual([0, 1, 2, 3, 4]);
  expect(events[0].response.status).toBe('in_progress');
  expect(events[0].response.output).toEqual([]);
  expect(events[1].item).toMatchObject({ id: events[2].item_id, type: 'message', status: 'in_progress' });
  expect(events[1].output_index).toBe(0);
  expect(events[2]).toMatchObject({ output_index: 0, content_index: 0, delta: '{"outcome":"allow"}' });
  expect(events[2].logprobs).toEqual([]);
  expect(events[3].item).toEqual(events[4].response.output[0]);
  expect(events[3].item.id).toBe(events[2].item_id);
  expect(events[3].output_index).toBe(0);
  expect(events[4].response.model).toBe('gpt-6-sol');
  expect(events[4].response.id).toBe(events[0].response.id);
  expect(events[4].response.created_at).toBe(events[0].response.created_at);
  expect(events[4].response.status).toBe('completed');
  expect(events[4].response.output_text).toBe('{"outcome":"allow"}');
  expect(events[4].response).not.toHaveProperty('usage');
  expect(events[0].response).not.toHaveProperty('usage');
  // Codex's streaming text consumer assembles output_text.delta frames.
  expect(
    JSON.parse(
      events
        .filter((event) => event.type === 'response.output_text.delta')
        .map((event) => event.delta)
        .join(''),
    ),
  ).toEqual({ outcome: 'allow' });
});

test('capture hint protects marker-only requests and ambiguous clones without consuming originals', async () => {
  for (const body of ['{"client_metadata":{"x-openai-subagent":"guardian"}}', '{', ' '.repeat(65)]) {
    const request = new Request('https://example.test/responses', { method: 'POST', body });
    expect(await guardianPayloadHint(request, { maxBytes: 64 })).toBe('sensitive');
    expect(await request.text()).toBe(body);
  }
  const ordinary = new Request('https://example.test/responses', { method: 'POST', body: '{"input":"ordinary"}' });
  expect(await guardianPayloadHint(ordinary, { maxBytes: 64 })).toBe('normal');
  expect(ordinary.bodyUsed).toBe(false);
  const unreadable = new Request('https://example.test/responses', {
    method: 'POST',
    body: new ReadableStream({
      start(c) {
        c.error(new Error('unreadable'));
      },
    }),
  });
  expect(await guardianPayloadHint(unreadable, { maxBytes: 64 })).toBe('sensitive');
});

test('capture hint stops a stalled clone when the inbound request aborts', async () => {
  const controller = new AbortController();
  const request = new Request('https://example.test/responses', {
    method: 'POST',
    signal: controller.signal,
    body: new ReadableStream({ pull() {} }),
  });
  const pending = guardianPayloadHint(request, { maxBytes: 64 });
  controller.abort();
  expect(await Promise.race([pending, Bun.sleep(50).then(() => 'stalled')])).toBe('sensitive');
});

const wrapperContext = {
  requestId: 'guardian-test',
  session: { key: 'sha256:test', source: 'generated' },
} as LogicalRequestContext;
const wrapperOptions = {
  userAgent: '',
  userAgentPolicy: 'fixed',
  guardianStrategy: 'systemOne',
  guardianProviderId: 'system-one',
  guardianModelId: 'review',
} as const;

test('System One evaluates changed policy rules and preserves every original evidence item', async () => {
  for (const [policy, risk, authorization, outcome] of [
    ['Deny low-risk writes without explicit authorization.', 'low', 'unknown', 'deny'],
    ['Allow high-risk fixture actions without separate authorization.', 'high', 'unknown', 'allow'],
    ['Allow critical-risk fixture actions after reapproval.', 'critical', 'high', 'allow'],
    ['# Workspace policy\n\n\n\nPermit the requested synthetic test.', 'low', 'high', 'allow'],
  ]) {
    const request = await configuredGuardianRequest(false);
    const body = await request.json();
    body.input[0].content[0].text = policy;
    body.input.splice(1, 0, {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Supplementary review instructions. '.repeat(100) }],
    });
    const originalText = JSON.stringify(body);
    let evaluations = 0;
    let originals = 0;
    const invoke = createGuardianRawInvoke({
      pluginOptions: wrapperOptions,
      original: async () => {
        originals++;
        return new Response('original');
      },
      evaluate: async ({ body: evaluated }) => {
        evaluations++;
        expect(evaluated).toMatchObject({ state: { input: body.input } });
        return choiceResult(risk!, authorization!, outcome!);
      },
    });
    const original = new Request(request.url, { method: 'POST', body: originalText });
    const response = await invoke(original, wrapperContext);
    expect(evaluations).toBe(1);
    expect(originals).toBe(0);
    expect(JSON.parse((await response.json()).output_text)).toMatchObject({ outcome });
    expect(await original.text()).toBe(originalText);
  }
});

test('System One falls back once on uncertainty without exposing policy or evaluator errors in diagnostics', async () => {
  for (const failure of ['uncertain', 'invalid', 'error'] as const) {
    const logs: unknown[] = [];
    let originals = 0;
    const invoke = createGuardianRawInvoke({
      pluginOptions: wrapperOptions,
      logger: {
        info: (...args: unknown[]) => {
          logs.push(args);
        },
      },
      original: async () => {
        originals++;
        return new Response('original');
      },
      evaluate: async () => {
        if (failure === 'error') throw new Error('PRIVATE_EVALUATOR_ERROR');
        return failure === 'invalid' ? {} : choiceResult('low', 'unknown', 'uncertain');
      },
    });
    expect(await (await invoke(await configuredGuardianRequest(false), wrapperContext)).text()).toBe('original');
    expect(originals).toBe(1);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).toContain(failure === 'error' ? 'evaluation_error' : 'invalid_result');
    expect(JSON.stringify(logs)).not.toContain('PRIVATE_EVALUATOR_ERROR');
    expect(JSON.stringify(logs)).not.toContain(syntheticGuardianInput[0]!.content![0]!.text!);
  }
});

test('recognized Guardian requests report structural fallback reasons before evaluator disclosure', async () => {
  for (const [reason, change] of [
    [
      'unsupported_profile',
      (body: any) => {
        body.text.format.schema.required.push('rationale');
      },
    ],
    [
      'incomplete_context',
      (body: any) => {
        body.input[0].content[0].text = ' ';
      },
    ],
    [
      'missing_pending_action',
      (body: any) => {
        body.input.pop();
      },
    ],
  ] as const) {
    const body = await (await configuredGuardianRequest(false)).json();
    change(body);
    const text = JSON.stringify(body);
    const logs: unknown[] = [];
    let evaluations = 0;
    let originals = 0;
    const invoke = createGuardianRawInvoke({
      pluginOptions: wrapperOptions,
      logger: {
        info: (...args: unknown[]) => {
          logs.push(args);
        },
      },
      original: async (request) => {
        originals++;
        expect(await request.text()).toBe(text);
        return new Response('original');
      },
      evaluate: async () => {
        evaluations++;
        return choiceResult('low', 'unknown', 'allow');
      },
    });
    const response = await invoke(
      new Request('https://example.test/v1/responses', { method: 'POST', body: text }),
      wrapperContext,
    );
    expect(await response.text()).toBe('original');
    expect(evaluations).toBe(0);
    expect(originals).toBe(1);
    expect(logs).toEqual([
      [
        'Guardian evaluation deferred to the original request path',
        { event: 'guardian.fallback', reason, requestId: 'guardian-test' },
      ],
    ]);
  }
});

async function configuredGuardianRequest(stream: boolean): Promise<Request> {
  const request = guardianRequest(syntheticGuardianInput);
  const body = (await request.json()) as Record<string, any>;
  body.model = 'arbitrary-review-model';
  body.stream = stream;
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(body),
  });
}

for (const strategy of ['systemOne', 'systemOneReviewDenied'] as const) {
  for (const outcome of ['allow', 'deny'] as const) {
    for (const stream of [false, true]) {
      test(`pre-route ${strategy} handles ${outcome} ${stream ? 'streaming' : 'JSON'} decisions`, async () => {
        let evaluations = 0;
        const invoke = createGuardianPreRouteInvoke({
          pluginOptions: { ...wrapperOptions, guardianStrategy: strategy },
          evaluate: async (input) => {
            evaluations++;
            expect(input.providerId).toBe('system-one');
            expect(input.modelId).toBe('review');
            expect(input.body).toMatchObject({ model: 'review', state: { input: visibleGuardianInput } });
            return outcome === 'allow'
              ? choiceResult('low', 'unknown', 'allow')
              : choiceResult('critical', 'unknown', 'deny');
          },
        });

        const response = await invoke(await configuredGuardianRequest(stream), wrapperContext);
        const declined = strategy === 'systemOneReviewDenied' && outcome === 'deny';
        expect(evaluations).toBe(1);
        if (declined) expect(response).toBeUndefined();
        else {
          expect(response?.status).toBe(200);
          expect(response?.headers.get('content-type')).toContain(stream ? 'text/event-stream' : 'application/json');
          expect(await response!.text()).toContain(stream ? 'response.completed' : outcome);
        }
      });
    }
  }
}

test('pre-route leaves the original request body untouched and does not classify by model id', async () => {
  const request = await configuredGuardianRequest(false);
  const expected = await request.clone().text();
  const invoke = createGuardianPreRouteInvoke({
    pluginOptions: wrapperOptions,
    evaluate: async () => choiceResult('low', 'unknown', 'allow'),
  });
  const response = await invoke(request, wrapperContext);
  expect(response?.status).toBe(200);
  expect(await request.text()).toBe(expected);
});

test('pre-route declines non-Guardian requests before evaluator dispatch', async () => {
  let evaluations = 0;
  const request = await configuredGuardianRequest(false);
  const body = (await request.json()) as Record<string, unknown>;
  body.client_metadata = { 'x-openai-subagent': 'ordinary' };
  const invoke = createGuardianPreRouteInvoke({
    pluginOptions: wrapperOptions,
    evaluate: async () => {
      evaluations++;
      return choiceResult('low', 'unknown', 'allow');
    },
  });
  expect(
    await invoke(new Request(request.url, { method: 'POST', body: JSON.stringify(body) }), wrapperContext),
  ).toBeUndefined();
  expect(evaluations).toBe(0);
});

for (const strategy of ['systemOne', 'systemOneReviewDenied'] as const) {
  for (const result of ['invalid', 'error'] as const) {
    test(`pre-route ${strategy} declines ${result} evaluation while caller remains live`, async () => {
      const invoke = createGuardianPreRouteInvoke({
        pluginOptions: { ...wrapperOptions, guardianStrategy: strategy },
        evaluate:
          result === 'invalid'
            ? async () => ({})
            : async () => {
                throw new Error('evaluation failed');
              },
      });
      await expect(invoke(await configuredGuardianRequest(false), wrapperContext)).resolves.toBeUndefined();
    });
  }
}

test('pre-route evaluation timeout declines without cancelling the live caller', async () => {
  const deadline = new AbortController();
  const started = Promise.withResolvers<void>();
  const invoke = createGuardianPreRouteInvoke({
    pluginOptions: wrapperOptions,
    timeoutSignal: () => deadline.signal,
    evaluate: async () => {
      started.resolve();
      return new Promise(() => {});
    },
  });
  const pending = invoke(await configuredGuardianRequest(false), wrapperContext);
  await started.promise;
  deadline.abort(new DOMException('Timeout', 'TimeoutError'));
  await expect(pending).resolves.toBeUndefined();
});

test('pre-route propagates caller cancellation instead of declining', async () => {
  const caller = new AbortController();
  const reason = new DOMException('Aborted', 'AbortError');
  const invoke = createGuardianPreRouteInvoke({
    pluginOptions: wrapperOptions,
    evaluate: async () => {
      caller.abort(reason);
      return choiceResult('low', 'unknown', 'allow');
    },
  });
  await expect(
    invoke(new Request(await configuredGuardianRequest(false), { signal: caller.signal }), wrapperContext),
  ).rejects.toBe(reason);
});

for (const strategy of ['systemOne', 'systemOneReviewDenied'] as const) {
  for (const outcome of ['allow', 'deny'] as const) {
    test(`wrapper ${strategy} returns final ${outcome} through the selected path`, async () => {
      let calls = 0;
      let evaluations = 0;
      const request = guardianRequest(syntheticGuardianInput);
      const expected = await request.clone().text();
      const originalResponse = Response.json({ original: outcome });
      const invocation = { originalTransportStarted: false, syntheticGuardianResponse: false };
      const invoke = createGuardianRawInvoke({
        pluginOptions: { ...wrapperOptions, guardianStrategy: strategy },
        original: async (original) => {
          calls++;
          expect(await original.text()).toBe(expected);
          return originalResponse;
        },
        evaluate: async (input) => {
          evaluations++;
          expect(input.providerId).toBe('system-one');
          expect(input.body.state.input).toEqual(visibleGuardianInput);
          return outcome === 'allow'
            ? choiceResult('low', 'unknown', 'allow')
            : choiceResult('critical', 'unknown', 'deny');
        },
      });
      const response = await invoke(request, wrapperContext, {
        upstreamStream: true,
        __aioGuardianInvocation: invocation,
      } as never);
      const fallback = strategy === 'systemOneReviewDenied' && outcome === 'deny';
      expect(calls).toBe(fallback ? 1 : 0);
      expect(evaluations).toBe(1);
      expect(invocation).toEqual({ originalTransportStarted: fallback, syntheticGuardianResponse: !fallback });
      if (fallback) expect(response).toBe(originalResponse);
      else expect(await response.text()).toContain('response.completed');
    });
  }
}

test('wrapper bypasses defaults, other resolved models and missing request context', async () => {
  for (const [strategy, context] of [
    ['default', wrapperContext],
    ['systemOne', undefined],
  ] as const) {
    let calls = 0;
    let evaluations = 0;
    const request = guardianRequest(syntheticGuardianInput);
    const text = await request.clone().text();
    const invoke = createGuardianRawInvoke({
      pluginOptions: { ...wrapperOptions, guardianStrategy: strategy },
      original: async (request) => {
        calls++;
        expect(await request.text()).toBe(text);
        return new Response();
      },
      evaluate: async () => {
        evaluations++;
        throw new Error('must not evaluate');
      },
    });
    await invoke(request, context);
    expect(calls).toBe(1);
    expect(evaluations).toBe(0);
  }
});

test('wrapper bypasses unrecognized strategies', async () => {
  let calls = 0;
  let evaluations = 0;
  const invoke = createGuardianRawInvoke({
    pluginOptions: { ...wrapperOptions, guardianStrategy: 'futureStrategy' as never },
    original: async () => {
      calls++;
      return new Response();
    },
    evaluate: async () => {
      evaluations++;
      throw new Error('must not evaluate');
    },
  });
  await invoke(guardianRequest(syntheticGuardianInput), wrapperContext);
  expect(calls).toBe(1);
  expect(evaluations).toBe(0);
});

test('wrapper falls back once on invalid answers or evaluator failure', async () => {
  for (const evaluate of [
    async () => ({}),
    async () => {
      throw new Error('failed');
    },
  ]) {
    let calls = 0;
    const invoke = createGuardianRawInvoke({
      pluginOptions: wrapperOptions,
      original: async () => {
        calls++;
        return new Response();
      },
      evaluate,
    });
    await invoke(guardianRequest(syntheticGuardianInput), wrapperContext);
    expect(calls).toBe(1);
  }
});

test('synchronous evaluator abort handles its rejection and never falls back', async () => {
  const controller = new AbortController();
  let calls = 0;
  const invoke = createGuardianRawInvoke({
    pluginOptions: wrapperOptions,
    original: async () => {
      calls++;
      return new Response();
    },
    evaluate: () => {
      controller.abort();
      return Promise.reject(controller.signal.reason);
    },
  });
  await expect(
    invoke(new Request(guardianRequest(syntheticGuardianInput), { signal: controller.signal }), wrapperContext),
  ).rejects.toThrow();
  await Bun.sleep(0);
  expect(calls).toBe(0);
});

test('abort while projection is pending prevents any dispatch after the body finishes', async () => {
  const body = await guardianRequest(syntheticGuardianInput).text();
  const controller = new AbortController();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let originalCalls = 0;
  let evaluations = 0;
  const request = new Request('https://example.test/v1/responses', {
    method: 'POST',
    signal: controller.signal,
    body: new ReadableStream({
      start(c) {
        stream = c;
      },
    }),
  });
  const invoke = createGuardianRawInvoke({
    pluginOptions: wrapperOptions,
    original: async () => {
      originalCalls++;
      return new Response();
    },
    evaluate: async () => {
      evaluations++;
      return {};
    },
  });
  const pending = invoke(request, wrapperContext);
  await Bun.sleep(0);
  controller.abort();
  stream.enqueue(new TextEncoder().encode(body));
  stream.close();
  await expect(pending).rejects.toThrow();
  await Bun.sleep(0);
  expect(originalCalls).toBe(0);
  expect(evaluations).toBe(0);
});

test('caller abort in the evaluation settlement microtask wins over synthetic output', async () => {
  const controller = new AbortController();
  let calls = 0;
  const invoke = createGuardianRawInvoke({
    pluginOptions: wrapperOptions,
    original: async () => {
      calls++;
      return new Response();
    },
    evaluate: () => {
      const result = Promise.resolve(choiceResult('low', 'unknown', 'allow'));
      void result.then(() => queueMicrotask(() => controller.abort()));
      return result;
    },
  });
  await expect(
    invoke(new Request(guardianRequest(syntheticGuardianInput), { signal: controller.signal }), wrapperContext),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

for (const abort of [false, true])
  test(`deadline remains authoritative during synchronous validation, caller aborted=${abort}`, async () => {
    let now = 0;
    const clock = spyOn(performance, 'now').mockImplementation(() => now);
    const controller = new AbortController();
    let calls = 0;
    try {
      const answer = choiceResult('low', 'unknown', 'allow');
      const evaluated = {
        get answers() {
          now = 8_001;
          if (abort) controller.abort();
          return answer.answers;
        },
      };
      const invoke = createGuardianRawInvoke({
        pluginOptions: wrapperOptions,
        original: async () => {
          calls++;
          return new Response('original');
        },
        evaluate: async () => evaluated,
      });
      const pending = invoke(
        new Request(guardianRequest(syntheticGuardianInput), { signal: controller.signal }),
        wrapperContext,
      );
      if (abort) await expect(pending).rejects.toThrow();
      else expect(await (await pending).text()).toBe('original');
      expect(calls).toBe(abort ? 0 : 1);
    } finally {
      clock.mockRestore();
    }
  });

test('evaluation timeout falls back once and ignores its late allow', async () => {
  const deadline = new AbortController();
  const started = Promise.withResolvers<void>();
  const late = Promise.withResolvers<unknown>();
  let calls = 0;
  const logs: unknown[] = [];
  const invoke = createGuardianRawInvoke({
    pluginOptions: wrapperOptions,
    logger: {
      info: (...args: unknown[]) => {
        logs.push(args);
      },
    },
    original: async () => {
      calls++;
      return new Response('original');
    },
    timeoutSignal: () => deadline.signal,
    evaluate: () => {
      started.resolve();
      return late.promise;
    },
  });
  const pending = invoke(guardianRequest(syntheticGuardianInput), wrapperContext);
  await started.promise;
  deadline.abort(new DOMException('Timeout', 'TimeoutError'));
  expect(await (await pending).text()).toBe('original');
  late.resolve(choiceResult('low', 'unknown', 'allow'));
  await Bun.sleep(0);
  expect(calls).toBe(1);
  expect(logs).toHaveLength(1);
  expect(JSON.stringify(logs)).toContain('evaluation_timeout');
});

test('original-model error after denial remains final without recursive evaluation', async () => {
  let calls = 0;
  let evaluations = 0;
  const failure = new Error('original failure');
  const invoke = createGuardianRawInvoke({
    pluginOptions: { ...wrapperOptions, guardianStrategy: 'systemOneReviewDenied' },
    original: async () => {
      calls++;
      throw failure;
    },
    evaluate: async () => {
      evaluations++;
      return choiceResult('critical', 'unknown', 'deny');
    },
  });
  await expect(invoke(guardianRequest(syntheticGuardianInput), wrapperContext)).rejects.toBe(failure);
  expect(calls).toBe(1);
  expect(evaluations).toBe(1);
});

test('reasoning metadata remains eligible after raw retry removes only encrypted_content', async () => {
  const body = await guardianRequest(syntheticGuardianInput).json();
  delete body.input[4].encrypted_content;
  const projection = await projectGuardianRequest(
    new Request('https://example.test/v1/responses', { method: 'POST', body: JSON.stringify(body) }),
  );
  expect(projection?.state.input).toEqual(body.input);
  body.input[4].encrypted_content = {};
  expect(
    await projectGuardianRequest(
      new Request('https://example.test/v1/responses', { method: 'POST', body: JSON.stringify(body) }),
    ),
  ).toBeUndefined();
});

test('rejects inaccessible opaque encrypted reasoning before Guardian dispatch', async () => {
  expect(await projectGuardianRequest(fixtureGuardianRequest(syntheticGuardianInput))).toBeUndefined();

  const visible = structuredClone(syntheticGuardianInput) as Record<string, unknown>[];
  delete visible[4]!['encrypted_content'];
  expect(await projectGuardianRequest(fixtureGuardianRequest(visible))).toBeDefined();
});

for (const abort of [false, true])
  test(`checks deadline and cancellation after building response, abort=${abort}`, async () => {
    let now = 0;
    const clock = spyOn(performance, 'now').mockImplementation(() => now);
    const controller = new AbortController();
    const wallClock = spyOn(Date, 'now').mockImplementation(() => {
      now = 8_001;
      if (abort) controller.abort();
      return 0;
    });
    let calls = 0;
    const invocation = { originalTransportStarted: false, syntheticGuardianResponse: false };
    try {
      const invoke = createGuardianRawInvoke({
        pluginOptions: wrapperOptions,
        original: async () => {
          calls++;
          return new Response('original');
        },
        evaluate: async () => choiceResult('low', 'unknown', 'allow'),
      });
      const pending = invoke(
        new Request(guardianRequest(syntheticGuardianInput), { signal: controller.signal }),
        wrapperContext,
        { upstreamStream: true, __aioGuardianInvocation: invocation } as never,
      );
      if (abort) await expect(pending).rejects.toThrow();
      else expect(await (await pending).text()).toBe('original');
      expect(calls).toBe(abort ? 0 : 1);
      expect(invocation.syntheticGuardianResponse).toBe(false);
    } finally {
      clock.mockRestore();
      wallClock.mockRestore();
    }
  });

test('already-expired evaluation signal never starts the lazy callback', async () => {
  let evaluations = 0;
  let originals = 0;
  const timer = spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
  try {
    const invoke = createGuardianRawInvoke({
      pluginOptions: wrapperOptions,
      original: async () => {
        originals++;
        return new Response();
      },
      evaluate: async () => {
        evaluations++;
        return {};
      },
    });
    await invoke(guardianRequest(syntheticGuardianInput), wrapperContext);
    expect([originals, evaluations]).toEqual([1, 0]);
  } finally {
    timer.mockRestore();
  }
});

test('private deadline seam keeps the production duration and cancels before fallback', async () => {
  const deadline = new AbortController();
  const caller = new AbortController();
  const started = Promise.withResolvers<void>();
  let timeoutMs: number | undefined;
  let originals = 0;
  const invoke = createGuardianRawInvoke({
    pluginOptions: wrapperOptions,
    timeoutSignal: (milliseconds) => {
      timeoutMs = milliseconds;
      return deadline.signal;
    },
    evaluate: async () => {
      started.resolve();
      return new Promise(() => {});
    },
    original: async () => {
      originals++;
      return new Response();
    },
  });
  const pending = invoke(
    new Request(guardianRequest(syntheticGuardianInput), { signal: caller.signal }),
    wrapperContext,
  );
  await started.promise;
  expect(timeoutMs).toBe(8_000);
  caller.abort(new DOMException('Aborted', 'AbortError'));
  deadline.abort(new DOMException('Timeout', 'TimeoutError'));
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(originals).toBe(0);
});

test('caller abort after original dispatch reaches the original transport unchanged', async () => {
  const caller = new AbortController();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const invoke = createGuardianRawInvoke({
    pluginOptions: wrapperOptions,
    evaluate: async () => ({}),
    original: (request) => {
      calls++;
      started.resolve();
      return new Promise((_resolve, reject) =>
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }),
      );
    },
  });
  const pending = invoke(
    new Request(guardianRequest(syntheticGuardianInput), { signal: caller.signal }),
    wrapperContext,
  );
  await started.promise;
  caller.abort(new DOMException('Aborted', 'AbortError'));
  await expect(pending).rejects.toBe(caller.signal.reason);
  expect(calls).toBe(1);
});

test('current bounded additional tools and whitespace envelope are eligible', async () => {
  const body = (await guardianRequest(syntheticGuardianInput).json()) as any;
  body.input.unshift({
    type: 'additional_tools',
    role: 'developer',
    id: 'tools',
    tools: [
      {
        type: 'namespace',
        name: 'functions',
        description: '',
        tools: [
          {
            type: 'custom',
            name: 'exec',
            description: '',
            format: { type: 'grammar', syntax: 'lark', definition: 'x' },
          },
        ],
      },
    ],
  });
  const parts = body.input.at(-1).content;
  parts.at(-4).text = `  ${parts.at(-4).text}  `;
  parts.at(-3).text = ` ${parts.at(-3).text} `;
  parts.at(-1).text = ` ${parts.at(-1).text} `;
  expect(
    await projectGuardianRequest(
      new Request('https://example.test/v1/responses', { method: 'POST', body: JSON.stringify(body) }),
    ),
  ).toBeDefined();
});

test('rejects unsafe additional tools and duplicate markers', async () => {
  const body = (await guardianRequest(syntheticGuardianInput).json()) as any;
  body.input.unshift({
    type: 'additional_tools',
    role: 'developer',
    id: 'tools',
    tools: [
      {
        type: 'namespace',
        name: 'functions',
        description: '',
        tools: [
          {
            type: 'function',
            name: 'wait',
            description: '',
            strict: false,
            parameters: {
              type: 'object',
              properties: {
                x: {
                  type: 'array',
                  items: {
                    type: 'array',
                    items: { type: 'array', items: { type: 'array', items: { type: 'object', evil: 'x' } } },
                  },
                },
              },
            },
          },
        ],
      },
    ],
  });
  const request = () =>
    new Request('https://example.test/v1/responses', { method: 'POST', body: JSON.stringify(body) });
  expect(await projectGuardianRequest(request())).toBeUndefined();
  const clean = (await guardianRequest(syntheticGuardianInput).json()) as any;
  clean.input.at(-1).content.push({ type: 'input_text', text: '>>> APPROVAL REQUEST START' });
  expect(
    await projectGuardianRequest(
      new Request('https://example.test/v1/responses', { method: 'POST', body: JSON.stringify(clean) }),
    ),
  ).toBeUndefined();
});

test('rejects oversized additional tool arrays and serialized descriptors', async () => {
  const body = (await guardianRequest(syntheticGuardianInput).json()) as any;
  const descriptor = {
    type: 'custom',
    name: 'x',
    description: '',
    format: { type: 'grammar', syntax: 'lark', definition: 'x' },
  };
  const namespace = { type: 'namespace', name: 'functions', description: '', tools: [descriptor] };
  const check = async () =>
    projectGuardianRequest(
      new Request('https://example.test/v1/responses', { method: 'POST', body: JSON.stringify(body) }),
    );
  body.input.unshift({
    type: 'additional_tools',
    role: 'developer',
    id: 'tools',
    tools: Array.from({ length: 1001 }, () => namespace),
  });
  expect(await check()).toBeUndefined();
  body.input[0].tools = [{ ...namespace, tools: Array.from({ length: 1001 }, () => descriptor) }];
  expect(await check()).toBeUndefined();
  body.input[0].tools = [
    {
      ...namespace,
      tools: [{ ...descriptor, format: { type: 'grammar', syntax: 'lark', definition: 'x'.repeat(20_001) } }],
    },
  ];
  expect(await check()).toBeUndefined();
});

test('rejects root array descriptor schemas while accepting nested arrays', async () => {
  const body = (await guardianRequest(syntheticGuardianInput).json()) as any;
  const custom = {
    type: 'custom',
    name: 'exec',
    description: '',
    format: { type: 'grammar', syntax: 'lark', definition: 'x' },
  };
  const fn = {
    type: 'function',
    name: 'wait',
    description: '',
    strict: false,
    parameters: { type: 'object', properties: { x: { type: 'array', items: { type: 'string' } } } },
  };
  const check = async () =>
    projectGuardianRequest(
      new Request('https://example.test/v1/responses', { method: 'POST', body: JSON.stringify(body) }),
    );
  body.input.unshift({
    type: 'additional_tools',
    role: 'developer',
    id: 'tools',
    tools: [{ type: 'namespace', name: 'functions', description: '', tools: [custom, fn] }],
  });
  expect(await check()).toBeDefined();
  body.input[0].tools[0].tools[0].format = [];
  expect(await check()).toBeUndefined();
  body.input[0].tools[0].tools[0].format = { type: 'grammar', syntax: 'lark', definition: 'x' };
  body.input[0].tools[0].tools[1].parameters = [];
  expect(await check()).toBeUndefined();
});
