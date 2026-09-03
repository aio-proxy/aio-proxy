import { expect, test } from 'bun:test';

import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';

import type { GoogleAntigravityCredential } from '../schema';
import { AntigravityTransport, type AntigravityTransportDependencies } from './transport';

test('reuses identity across short retry, endpoint fallback, and one forced refresh', async () => {
  const seen: Request[] = [];
  const sleeps: number[] = [];
  const fixture = fixtureTransport(
    [
      Response.json({}, { status: 429, headers: { 'Retry-After': '1' } }),
      Response.json({ error: { message: 'no capacity' } }, { status: 503 }),
      Response.json({}, { status: 401 }),
      Response.json({ response: { candidates: [] } }),
    ],
    seen,
    { sleep: async (milliseconds) => sleeps.push(milliseconds) },
  );

  const response = await fixture.transport.execute(executeInput());

  expect(response.status).toBe(200);
  expect(fixture.refreshes()).toBe(1);
  expect(sleeps).toEqual([1_000]);
  expect(new Set(await Promise.all(seen.map(identityTuple))).size).toBe(1);
  expect(seen.map((request) => new URL(request.url).origin)).toEqual([
    'https://daily-cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
  ]);
});

test('prefers the last successful sandbox origin for the same project', async () => {
  const origins: string[] = [];
  const scripted = [
    Response.json({ error: { message: 'No capacity is available' } }, { status: 503 }),
    Response.json({ response: { candidates: [] } }),
    Response.json({ response: { candidates: [] } }),
  ];
  let index = 0;
  const credential = credentialFixture({ projectId: 'last-good-project' });
  const dependencies = {
    credentials: { current: async () => credential, forceRefresh: async () => credential },
    fetch: async (input: RequestInfo) => {
      origins.push(new URL(String(input)).origin);
      return scripted[index++] ?? Response.json({ response: {} });
    },
  };
  await new AntigravityTransport(dependencies).execute(executeInput());
  await new AntigravityTransport(dependencies).execute(executeInput());
  expect(origins).toEqual([
    'https://daily-cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
  ]);
});

test('does not remember a non-2xx origin as last-good', async () => {
  const origins: string[] = [];
  const scripted = [
    Response.json({ error: { message: 'No capacity is available' } }, { status: 503 }),
    Response.json({ error: { message: 'boom' } }, { status: 500 }),
    Response.json({ response: { candidates: [] } }),
  ];
  let index = 0;
  const credential = credentialFixture({ projectId: `last-good-500-${crypto.randomUUID()}` });
  const dependencies = {
    credentials: { current: async () => credential, forceRefresh: async () => credential },
    fetch: async (input: RequestInfo) => {
      origins.push(new URL(String(input)).origin);
      return scripted[index++] ?? Response.json({ response: {} });
    },
  };

  const failed = await new AntigravityTransport(dependencies).execute(executeInput());
  expect(failed.status).toBe(500);
  await new AntigravityTransport(dependencies).execute(executeInput());

  expect(origins).toEqual([
    'https://daily-cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
    'https://daily-cloudcode-pa.googleapis.com',
  ]);
});

test('reuses session agent identity and echoes last_execution_id', async () => {
  const seen: Request[] = [];
  const sessionKey = `sha256:${crypto.randomUUID()}` as const;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async (input, init) => {
      seen.push(new Request(input, init));
      if (seen.length === 1) return Response.json({ response: { responseId: 'exec-first', candidates: [] } });
      return Response.json({ response: { candidates: [] } });
    },
  });

  await transport.execute(executeInput({ context: logicalContext({ sessionKey }) }));
  await transport.execute(executeInput({ context: logicalContext({ sessionKey }) }));

  const envelopes = await Promise.all(seen.map((request) => request.clone().json()));
  const first = envelopes[0] as { requestId: string; request: { labels: Record<string, string> } };
  const second = envelopes[1] as { requestId: string; request: { labels: Record<string, string> } };
  const firstId = first.requestId.split('/');
  const secondId = second.requestId.split('/');
  expect(firstId).toHaveLength(5);
  expect(secondId).toHaveLength(5);
  expect(firstId[0]).toBe('agent');
  expect(firstId[1]).toBe(secondId[1]);
  expect(firstId[3]).toBe(secondId[3]);
  expect(firstId[4]).toBe('1');
  expect(secondId[4]).toBe('2');
  expect(first.request.labels.last_execution_id).toBeUndefined();
  expect(second.request.labels.last_execution_id).toBe('exec-first');
});

test('does not let countTokens consume generation session state', async () => {
  const seen: Request[] = [];
  const sessionKey = `sha256:${crypto.randomUUID()}` as const;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async (input, init) => {
      seen.push(new Request(input, init));
      if (seen.length === 1) return Response.json({ response: { responseId: 'exec-first', candidates: [] } });
      if (seen.length === 2) return Response.json({ totalTokens: 9 });
      return Response.json({ response: { candidates: [] } });
    },
  });

  await transport.execute(executeInput({ context: logicalContext({ sessionKey }) }));
  await transport.execute(executeInput({ context: logicalContext({ sessionKey }), operation: 'countTokens' }));
  await transport.execute(executeInput({ context: logicalContext({ sessionKey }) }));

  const envelopes = await Promise.all(seen.map((request) => request.clone().json()));
  const ids = envelopes.map((envelope) => String(envelope.requestId).split('/'));
  expect(ids[0]?.[4]).toBe('1');
  expect(ids[2]?.[4]).toBe('2');
  expect(ids[1]?.[1]).not.toBe(ids[0]?.[1]);
  expect(envelopes[2]?.request.labels.last_execution_id).toBe('exec-first');
});

test('reapplies skip signature when retrying without replay', async () => {
  const seen: Request[] = [];
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    options: { baseURL: 'https://example.test' },
    fetch: async (input, init) => {
      seen.push(new Request(input, init));
      if (seen.length === 1) {
        return Response.json({ error: { message: 'function call has invalid thoughtSignature' } }, { status: 400 });
      }
      return Response.json({ response: { candidates: [] } });
    },
  });

  const unsigned = {
    contents: [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'a', args: {} } }, { functionCall: { name: 'b', args: {} } }],
      },
    ],
  };
  await transport.execute(executeInput({ body: unsigned, modelId: 'gemini-3-flash-agent' }));

  const envelopes = await Promise.all(seen.map((request) => request.clone().json()));
  expect(seen).toHaveLength(2);
  for (const envelope of envelopes) {
    expect(envelope.request.contents[0].parts[0].thoughtSignature).toBe('skip_thought_signature_validator');
    expect(envelope.request.contents[0].parts[1].thoughtSignature).toBeUndefined();
  }
});

test('expires unused session identity after one hour', async () => {
  const seen: Request[] = [];
  let now = 1_000;
  const sessionKey = `sha256:${crypto.randomUUID()}` as const;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    now: () => now,
    fetch: async (input, init) => {
      seen.push(new Request(input, init));
      return Response.json({ response: { candidates: [] } });
    },
  });

  await transport.execute(executeInput({ context: logicalContext({ sessionKey }) }));
  now += 3_600_000;
  await transport.execute(executeInput({ context: logicalContext({ sessionKey }) }));

  const envelopes = await Promise.all(seen.map((request) => request.clone().json()));
  const first = String(envelopes[0]?.requestId).split('/');
  const second = String(envelopes[1]?.requestId).split('/');
  expect(first[1]).not.toBe(second[1]);
  expect(first[3]).not.toBe(second[3]);
  expect(first[4]).toBe('1');
  expect(second[4]).toBe('1');
});

test('applies catalog wire profiles on the initial envelope and the retry envelope', async () => {
  const seen: Request[] = [];
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    descriptorById: new Map([
      [
        'gemini-4.0-flash-preview',
        {
          id: 'gemini-4.0-flash-preview',
          extra: { antigravity: { modelEnum: 'MODEL_GEMINI_4_FLASH', maxOutputTokens: 8192 } },
        },
      ],
    ]),
    familyByWireId: () => undefined,
    fetch: async (input, init) => {
      seen.push(new Request(input, init));
      if (seen.length === 1) return Response.json({}, { status: 401 });
      return Response.json({ response: {} });
    },
  });

  await transport.execute(executeInput({ modelId: 'gemini-4.0-flash-preview' }));

  expect(seen).toHaveLength(2);
  const envelopes = await Promise.all(seen.map((request) => request.clone().json()));
  for (const envelope of envelopes) {
    expect(envelope).toMatchObject({
      model: 'gemini-4.0-flash-preview',
      request: {
        generationConfig: { maxOutputTokens: 8192 },
        labels: { model_enum: 'MODEL_GEMINI_4_FLASH' },
      },
    });
  }
});

test('forces refresh once and returns a second authorization failure', async () => {
  const fixture = fixtureTransport([Response.json({}, { status: 403 }), Response.json({}, { status: 401 })], []);

  const response = await fixture.transport.execute(executeInput());

  expect(response.status).toBe(401);
  expect(fixture.refreshes()).toBe(1);
});

test('uses only the outbound header whitelist', async () => {
  let seen: Request | undefined;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async (input, init) => {
      seen = new Request(input, init);
      return Response.json({ response: {} });
    },
  });

  await transport.execute(executeInput());

  expect(seen?.headers.get('authorization')).toBe('Bearer access-1');
  expect(seen?.headers.get('content-type')).toBe('application/json');
  expect(seen?.headers.get('accept')).toBe('application/json');
  expect(seen?.headers.get('user-agent')).toMatch(/^antigravity\/hub\//u);
  for (const forbidden of ['cookie', 'x-client-request-id', 'x-stainless-runtime', 'sec-ch-ua']) {
    expect(seen?.headers.has(forbidden)).toBe(false);
  }
});

test('shares replay across Antigravity transport instances without a Provider ID key', async () => {
  const modelId = `claude-replay-${crypto.randomUUID()}`;
  const sessionKey = `sha256:${crypto.randomUUID()}` as const;
  const signature = 'shared-signature-'.repeat(4);
  const first = new AntigravityTransport({
    credentials: credentialSource(),
    options: { baseURL: 'https://first-provider.test' },
    fetch: async () =>
      Response.json({
        response: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { id: 'call-1', name: 'weather', args: {} }, thoughtSignature: signature }],
              },
              finishReason: 'STOP',
            },
          ],
        },
      }),
  });
  await first.execute(
    executeInput({ modelId, context: logicalContext({ requestId: crypto.randomUUID(), sessionKey }) }),
  );

  let fallbackBody = '';
  const fallback = new AntigravityTransport({
    credentials: credentialSource(),
    options: { baseURL: 'https://fallback-provider.test' },
    fetch: async (_input, init) => {
      fallbackBody = String(init?.body);
      return Response.json({ response: { candidates: [] } });
    },
  });
  await fallback.execute(
    executeInput({
      body: {
        contents: [{ role: 'user', parts: [{ functionResponse: { id: 'call-1', name: 'weather', response: {} } }] }],
      },
      modelId,
      context: logicalContext({ requestId: crypto.randomUUID(), sessionKey }),
    }),
  );

  expect(fallbackBody).toContain(signature);
});

function fixtureTransport(
  responses: Array<Response | Error>,
  seen: Request[],
  overrides: Partial<AntigravityTransportDependencies> = {},
) {
  let index = 0;
  let refreshCount = 0;
  const transport = new AntigravityTransport({
    credentials: {
      current: async () => credentialFixture(),
      forceRefresh: async () => {
        refreshCount += 1;
        return credentialFixture({ accessToken: 'access-2' });
      },
    },
    fetch: async (input, init) => {
      seen.push(new Request(input, init));
      const scripted = responses[index++];
      if (scripted instanceof Error) throw scripted;
      return scripted ?? Response.json({ response: {} });
    },
    ...overrides,
  });
  return { transport, refreshes: () => refreshCount };
}

function executeInput(overrides: Partial<Parameters<AntigravityTransport['execute']>[0]> = {}) {
  return {
    body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    context: logicalContext(),
    modelId: 'gemini-3-flash-agent',
    requestType: 'agent' as const,
    stream: false,
    ...overrides,
  };
}

async function identityTuple(request: Request): Promise<string> {
  const body = (await request.clone().json()) as {
    readonly requestId: string;
    readonly request: { readonly sessionId: string };
  };
  return `${body.requestId}:${body.request.sessionId}:${await request.clone().text()}`;
}

function uniqueProjectId(): string {
  return `project-${crypto.randomUUID()}`;
}

function credentialSource() {
  const credential = credentialFixture();
  return { current: async () => credential, forceRefresh: async () => credential };
}

function credentialFixture(overrides: Partial<GoogleAntigravityCredential> = {}): GoogleAntigravityCredential {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 1_900_000_000_000,
    email: 'person@example.com',
    projectId: uniqueProjectId(),
    ...overrides,
  };
}

function logicalContext(
  overrides: { readonly requestId?: string; readonly sessionKey?: `sha256:${string}` } = {},
): LogicalRequestContext {
  return {
    requestId: overrides.requestId ?? '00000000-0000-4000-8000-000000000001',
    session: { key: overrides.sessionKey ?? 'sha256:abc', source: 'transcript' },
  };
}
