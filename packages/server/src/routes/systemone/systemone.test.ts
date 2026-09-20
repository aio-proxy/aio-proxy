import { expect, test } from 'bun:test';

import type { EvaluationResult } from '@aio-proxy/core';
import { ProviderKind } from '@aio-proxy/types';

import { createServer } from '#server-test-lifecycle';

import type { RuntimeProviderInstance } from '../../runtime';

const MODEL_ID = 'jev-latest';

const body = (payload: Record<string, unknown>): RequestInit => ({
  body: JSON.stringify(payload),
  headers: { 'content-type': 'application/json' },
  method: 'POST',
});

const QUESTION = { q: { type: 'noul', instructions: 'Did it answer in French?' } };

/** Mounting is what this asserts. A route that is constructed but never handed to
 *  `app.route(...)` answers Hono's 404 here, which no adapter-level test can see. The
 *  parse error is the adapter's own — flat `{ message, error_type }`, not an OpenAI
 *  envelope — so reaching it proves the System One adapter is the one wired in. */
test('POST /v1/systemone is mounted and answers with the adapter parse error', async () => {
  const app = await createServer({ config: { providers: {} } });

  const response = await app.request('/v1/systemone', body({ model: MODEL_ID, questions: QUESTION }));

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ message: 'state is required', error_type: 'invalid_request_error' });
});

/** The whole chain in one request: route -> pipeline -> capability filter -> evaluation
 *  dispatch -> System One egress. The candidate carries `evaluation` only, so a filter
 *  that still rejects the capability answers 404 `not_found_error` instead. */
test('POST /v1/systemone dispatches an evaluation candidate and returns System One JSON', async () => {
  const app = await createServer({ config: { providers: {} }, providerInstances: [evaluationProvider()] });

  const response = await app.request(
    '/v1/systemone',
    body({ model: MODEL_ID, state: 'the assistant replied in French', questions: QUESTION }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    model: MODEL_ID,
    answers: { q: { type: 'noul', noul: 0.93 } },
    usage: { input_tokens: 312, output_tokens: 48 },
  });
});

const NOUL_RESULT: EvaluationResult = {
  answers: { q: { type: 'noul', noul: 0.93 } },
  usage: { inputTokens: 312, outputTokens: 48 },
};

// `model` rides along because `evaluation` alone is not one of the runtime's transport
// arms; it must never be called on this path.
function evaluationProvider(): RuntimeProviderInstance {
  const evaluate = async (): Promise<EvaluationResult> => NOUL_RESULT;
  return {
    capabilityIndex: { [MODEL_ID]: new Set(['evaluation']) },
    enabled: true,
    evaluation: { discover: async () => ({ kind: 'supported', evaluate }), evaluate },
    id: 'gateway',
    kind: ProviderKind.AiSdk,
    model: {
      invoke: () => {
        throw new Error('evaluation must never call the language model transport');
      },
    },
    models: [MODEL_ID],
  };
}
