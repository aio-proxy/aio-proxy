import { expect, test } from 'bun:test';

import { jsonRequest, REQUESTED_MODEL, rawProvider } from '../../../__tests__/pipeline-helpers';
import { attributeName, spanName } from '../../request-tracing';
import { pipeline } from './test-support';

test('records inbound fast-mode from body service_tier', async () => {
  const harness = pipeline([rawProvider({ id: 'raw' })]);

  expect(
    (await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping', service_tier: 'priority' }))).status,
  ).toBe(200);
  expect(harness.recording.spans.find((span) => span.name === spanName.request)?.attributes[attributeName.fast]).toBe(
    true,
  );
});

test('records inbound fast-mode from body speed', async () => {
  const harness = pipeline([rawProvider({ id: 'raw' })]);

  expect((await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping', speed: 'fast' }))).status).toBe(200);
  expect(harness.recording.spans.find((span) => span.name === spanName.request)?.attributes[attributeName.fast]).toBe(
    true,
  );
});

test('records inbound fast-mode from the Anthropic beta header', async () => {
  const harness = pipeline([rawProvider({ id: 'raw' })]);
  const request = new Request('http://localhost/v1/test', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-beta': 'fast-mode-2026-02-01',
    },
    body: JSON.stringify({ model: REQUESTED_MODEL, prompt: 'ping' }),
  });

  expect((await harness.run(request)).status).toBe(200);
  expect(harness.recording.spans.find((span) => span.name === spanName.request)?.attributes[attributeName.fast]).toBe(
    true,
  );
});

test('does not mark ordinary requests as fast-mode', async () => {
  const harness = pipeline([rawProvider({ id: 'raw' })]);

  expect((await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }))).status).toBe(200);
  expect(
    harness.recording.spans.find((span) => span.name === spanName.request)?.attributes[attributeName.fast],
  ).toBeUndefined();
});
