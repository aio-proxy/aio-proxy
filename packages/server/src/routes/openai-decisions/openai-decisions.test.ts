import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { aioHome } from '@aio-proxy/core';

import { createServer } from '#server-test-lifecycle';

// The optional TypeSafe SDK is not installed in the isolated test home. This
// fixture models its external wire boundary; loading, experimental_evaluate,
// routing, conversion and HTTP transport remain production code.
const sdkDirectory = join(
  aioHome(),
  'packages',
  encodeURIComponent('@ai-sdk/typesafe-ai'),
  'node_modules',
  '@ai-sdk',
  'typesafe-ai',
);
beforeAll(() => {
  mkdirSync(sdkDirectory, { recursive: true });
  writeFileSync(
    join(sdkDirectory, 'package.json'),
    JSON.stringify({ name: '@ai-sdk/typesafe-ai', version: '3.0.16', main: 'index.mjs' }),
  );
  writeFileSync(
    join(sdkDirectory, 'index.mjs'),
    `export function createTypeSafe(options = {}) {
    return Object.assign(() => undefined, { evaluationModel: (modelId) => ({
      specificationVersion: 'v4', provider: 'typesafe', modelId,
      supportedQuestionTypes: ['boolean', 'choice', 'score'],
      async doEvaluate({ state, questions, abortSignal }) {
        const projected = Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, { ...question, type: question.type === 'boolean' ? 'noul' : question.type }]));
        const response = await (options.fetch ?? fetch)(options.baseURL + '/v1/systemone', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: modelId, state, questions: projected }), signal: abortSignal });
        const result = await response.json();
        const confidence = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [id, answer.confidence]));
        const answers = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [id, answer.type === 'noul' ? { type: 'boolean', probability: answer.noul } : answer]));
        return { answers, providerMetadata: { typesafe: { confidence } }, usage: result.usage === undefined ? undefined : { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens }, warnings: [] };
      }
    }) });
  }`,
  );
});
afterAll(() => rmSync(sdkDirectory, { recursive: true, force: true }));

const servers: Bun.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function upstream(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
const request = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const predicate = { type: 'predicate', name: 'greeting', instructions: 'Is this a greeting?' };

test('converts a Decisions predicate through the existing SystemOne evaluation capability', async () => {
  const baseURL = upstream(async (raw) => {
    expect(new URL(raw.url).pathname).toBe('/v1/systemone');
    expect(await raw.json()).toEqual({
      model: 'jev',
      state: 'Hello',
      questions: { greeting: { type: 'noul', instructions: 'Is this a greeting?' } },
    });
    return Response.json({
      model: 'jev',
      answers: { greeting: { type: 'noul', noul: 0.9 } },
      usage: { input_tokens: 3, output_tokens: 0 },
    });
  });
  const app = await createServer({
    config: { providers: { judge: { kind: 'api', protocol: 'typesafe-systemone', baseURL, alias: { judge: 'jev' } } } },
  });
  const response = await app.request(
    '/v1/decisions',
    request({ model: 'judge', input: 'Hello', questions: [predicate] }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    model: 'judge',
    answers: [{ type: 'predicate', name: 'greeting', probability: 0.9 }],
    usage: {
      input_tokens: 3,
      output_tokens: 0,
      total_tokens: 3,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  });
});

test('preserves boolean and string choice values separately and score labels during conversion', async () => {
  const baseURL = upstream(async (raw) => {
    const body = (await raw.json()) as { questions: Record<string, { criteria: unknown }> };
    expect(body.questions['category']?.criteria).toEqual({ '0': 'true: Boolean', '1': '"true": String' });
    expect(body.questions['severity']?.criteria).toEqual(['Low: Cosmetic', 'High: Blocked']);
    return Response.json({
      answers: {
        category: { type: 'choice', choice: '1', probabilities: { '0': 0.1, '1': 0.9 }, confidence: 0.8 },
        severity: { type: 'score', score: 0.75, probabilities: { '0': 0.25, '1': 0.75 }, confidence: 0.7 },
      },
    });
  });
  const app = await createServer({
    config: { providers: { judge: { kind: 'api', protocol: 'typesafe-systemone', baseURL, models: ['jev'] } } },
  });
  const response = await app.request(
    '/v1/decisions',
    request({
      model: 'jev',
      input: 'Hello',
      questions: [
        {
          type: 'choice',
          name: 'category',
          instructions: 'Category?',
          choices: [
            { value: true, description: 'Boolean' },
            { value: 'true', description: 'String' },
          ],
        },
        {
          type: 'score',
          name: 'severity',
          instructions: 'Severity?',
          levels: [
            { label: 'Low', description: 'Cosmetic' },
            { label: 'High', description: 'Blocked' },
          ],
        },
      ],
    }),
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as { answers: unknown }).answers).toEqual([
    {
      type: 'choice',
      name: 'category',
      choice: 'true',
      probabilities: [
        { value: true, probability: 0.1 },
        { value: 'true', probability: 0.9 },
      ],
      confidence: 0.8,
    },
    {
      type: 'score',
      name: 'severity',
      score: 0.75,
      probabilities: [
        { value: 0, label: 'Low', probability: 0.25 },
        { value: 1, label: 'High', probability: 0.75 },
      ],
      confidence: 0.7,
    },
  ]);
});

test('raw Decisions passthrough rewrites the model and retains extensions, images, refusals and query', async () => {
  const input = [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }] }];
  const questions = [
    predicate,
    { type: 'score', name: 'severity', instructions: 'Severity?', levels: [{ label: 'Low' }, { label: 'High' }] },
  ];
  const baseURL = upstream(async (raw) => {
    expect(new URL(raw.url).pathname).toBe('/custom/decisions');
    expect(new URL(raw.url).search).toBe('?trace=yes');
    expect(raw.headers.get('authorization')).toBe('Bearer upstream-secret');
    expect(await raw.json()).toEqual({ model: 'gpt-6-luna', input, questions, extra: 'kept' });
    return Response.json({
      answers: [{ type: 'refusal', name: 'greeting' }],
      usage: { input_tokens: 3 },
      extra: 'kept',
    });
  });
  const app = await createServer({
    config: {
      providers: {
        judge: {
          kind: 'api',
          endpoints: [{ protocol: 'openai-decisions', baseURL: `${baseURL}/custom` }],
          apiKey: 'upstream-secret',
          alias: { judge: 'gpt-6-luna' },
        },
      },
    },
  });
  const response = await app.request(
    '/v1/decisions?trace=yes',
    request({ model: 'judge', input, questions, extra: 'kept' }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    answers: [{ type: 'refusal', name: 'greeting' }],
    usage: { input_tokens: 3 },
    extra: 'kept',
  });
});

test('SystemOne uses a native Decisions endpoint through the same evaluation candidate loop', async () => {
  const baseURL = upstream(async (raw) => {
    expect(new URL(raw.url).pathname).toBe('/v1/decisions');
    expect(await raw.json()).toEqual({
      model: 'gpt-6-luna',
      input: 'Hello',
      questions: [
        { type: 'predicate', name: 'greeting', instructions: 'Is this a greeting?' },
        { type: 'score', name: 'severity', instructions: 'Severity?', levels: [{ label: 'Low' }, { label: 'High' }] },
      ],
    });
    return Response.json({
      answers: [
        { type: 'predicate', name: 'greeting', probability: 0.95 },
        {
          type: 'score',
          name: 'severity',
          score: 0.75,
          probabilities: [
            { value: 0, label: 'Low', probability: 0.25 },
            { value: 1, label: 'High', probability: 0.75 },
          ],
          confidence: 0.8,
        },
      ],
      usage: { input_tokens: 4 },
    });
  });
  const app = await createServer({
    config: {
      providers: { judge: { kind: 'api', protocol: 'openai-decisions', baseURL, alias: { judge: 'gpt-6-luna' } } },
    },
  });
  const response = await app.request(
    '/v1/systemone',
    request({
      model: 'judge',
      state: 'Hello',
      questions: {
        greeting: { type: 'noul', instructions: 'Is this a greeting?' },
        severity: { type: 'score', instructions: 'Severity?', criteria: ['Low', 'High'] },
      },
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    model: 'judge',
    answers: {
      greeting: { type: 'noul', noul: 0.95 },
      severity: { type: 'score', score: 0.75, probabilities: { '0': 0.25, '1': 0.75 }, confidence: 0.8 },
    },
    usage: { input_tokens: 4, output_tokens: 0 },
  });
});

test('fails over from an upstream failure to another evaluation provider', async () => {
  const failed = upstream(() => Response.json({ error: { message: 'unavailable' } }, { status: 503 }));
  const backup = upstream(() => Response.json({ answers: { greeting: { type: 'noul', noul: 0.8 } } }));
  const app = await createServer({
    config: {
      providers: {
        first: { kind: 'api', protocol: 'openai-decisions', baseURL: failed, models: ['judge'], priority: 10 },
        backup: { kind: 'api', protocol: 'typesafe-systemone', baseURL: backup, models: ['judge'] },
      },
    },
  });
  const response = await app.request(
    '/v1/decisions',
    request({ model: 'judge', input: 'Hello', questions: [predicate] }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ answers: [{ probability: 0.8 }] });
});

test('raw passthrough forwards an HTTP(S) image URL without fetching it', async () => {
  const input = [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/image.png' }] }];
  const baseURL = upstream(async (raw) => {
    expect(await raw.json()).toEqual({ model: 'gpt-6-luna', input, questions: [predicate] });
    return Response.json({
      answers: [{ type: 'predicate', name: 'greeting', probability: 0.4 }],
      usage: { input_tokens: 2 },
    });
  });
  const app = await createServer({
    config: {
      providers: { judge: { kind: 'api', protocol: 'openai-decisions', baseURL, alias: { judge: 'gpt-6-luna' } } },
    },
  });
  const response = await app.request('/v1/decisions', request({ model: 'judge', input, questions: [predicate] }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ answers: [{ probability: 0.4 }] });
});

test('rejects invalid questions and image URLs before calling an upstream', async () => {
  let calls = 0;
  const baseURL = upstream(() => {
    calls += 1;
    throw new Error('invalid request reached upstream');
  });
  const app = await createServer({
    config: { providers: { judge: { kind: 'api', protocol: 'typesafe-systemone', baseURL, models: ['judge'] } } },
  });
  for (const body of [
    { model: 'judge', input: 'Hello', questions: [predicate, predicate] },
    ...[
      [{ value: 'only' }],
      [{ value: 1 }, { value: 'one' }],
      Array.from({ length: 256 }, (_, index) => ({ value: String(index) })),
    ].map((choices) => ({
      model: 'judge',
      input: 'Hello',
      questions: [{ type: 'choice', instructions: 'Pick one', choices }],
    })),
    {
      model: 'judge',
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'ftp://example.com/image.png' }] }],
      questions: [predicate],
    },
  ]) {
    const response = await app.request('/v1/decisions', request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  }
  expect(calls).toBe(0);
});

test('rejects deeply nested passthrough extensions before dispatch or fallback', async () => {
  let calls = 0;
  const baseURL = upstream(() => {
    calls += 1;
    return Response.json({ answers: [] });
  });
  const app = await createServer({
    config: {
      providers: {
        first: { kind: 'api', protocol: 'openai-decisions', baseURL, models: ['judge'], priority: 10 },
        second: { kind: 'api', protocol: 'openai-decisions', baseURL, models: ['judge'] },
      },
    },
  });
  const body =
    JSON.stringify({ model: 'judge', input: 'Hello', questions: [predicate] }).slice(0, -1) +
    ',"extra":' +
    '{"nested":'.repeat(6000) +
    '0' +
    '}'.repeat(6000) +
    '}';
  const response = await app.request('/v1/decisions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  expect(calls).toBe(0);
});
