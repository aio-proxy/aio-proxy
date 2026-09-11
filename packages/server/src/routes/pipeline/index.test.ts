import { expect, test } from 'bun:test';

import {
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  rawProvider,
  textStream,
} from '../../../__tests__/pipeline-helpers';
import { pipeline } from './test-support';

test('releases the retained body when protocol request validation fails', async () => {
  const harness = pipeline([rawProvider({ id: 'raw' })]);
  const request = jsonRequest({ prompt: 'missing model' });

  const response = await harness.run(request);

  expect(response.status).toBe(400);
  expect(request.bodyUsed).toBe(true);
  expect(harness.recording.begins).toEqual([{ inboundProtocol: 'openai-compatible' }]);
  expect(harness.recording.finals).toEqual([
    { outcome: 'failure', finalStatusCode: 400, errorCode: 'invalid_request' },
  ]);
});

test('keeps the raw body replayable after protocol parsing succeeds', async () => {
  let forwarded: unknown;
  const provider = rawProvider({
    id: 'raw',
    invoke: async (request) => {
      forwarded = await request.clone().json();
      return Response.json({ provider: 'raw' });
    },
  });
  const harness = pipeline([provider]);
  const request = jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' });

  const response = await harness.run(request);

  expect(response.status).toBe(200);
  expect(provider.calls.raw).toHaveLength(1);
  expect(forwarded).toEqual({ model: 'raw-model', prompt: 'ping', stream: false });
  expect(provider.calls.raw[0]?.bodyUsed).toBe(true);
  expect(request.bodyUsed).toBe(true);
});

test('releases the retained body after replaying it across raw fallback candidates', async () => {
  const bodies: unknown[] = [];
  const primary = rawProvider({
    id: 'primary',
    invoke: async (request) => {
      bodies.push(await request.clone().json());
      return Response.json({}, { status: 503 });
    },
  });
  const backup = rawProvider({
    id: 'backup',
    invoke: async (request) => {
      bodies.push(await request.clone().json());
      return Response.json({ provider: 'backup' });
    },
  });
  const harness = pipeline([primary, backup]);
  const request = jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' });

  const response = await harness.run(request);

  expect(response.status).toBe(200);
  expect(bodies).toEqual([
    { model: 'primary-model', prompt: 'ping', stream: false },
    { model: 'backup-model', prompt: 'ping', stream: false },
  ]);
  expect(primary.calls.raw[0]?.bodyUsed).toBe(true);
  expect(backup.calls.raw[0]?.bodyUsed).toBe(true);
  expect(request.bodyUsed).toBe(true);
});

test('releases the retained body after a successful model response', async () => {
  const harness = pipeline([modelProvider({ id: 'model', invoke: () => textStream('ok') })]);
  const request = jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' });

  const response = await harness.run(request);

  expect(await response.json()).toEqual({ output: 'ok' });
  expect(request.bodyUsed).toBe(true);
});
