import { expect, test } from 'bun:test';

import type { StoredSpan } from '@aio-proxy/core/db';
import { SpanStatusCode } from '@opentelemetry/api';

import { jsonRequest, rawProvider, REQUESTED_MODEL, settleRecording } from '../../../__tests__/pipeline-helpers';
import { attributeName, spanName } from '../../request-tracing';
import { pipeline } from './test-support';

// Indexes one recording's spans by name and projects "who is whose parent" in
// readable terms. `find` keeps the first span of a name so repeated names (many
// provider attempts) resolve to the earliest one.
function tree(spans: readonly StoredSpan[]) {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const find = (name: string) => spans.find((span) => span.name === name);
  return {
    find,
    parentNameOf: (name: string) => {
      const parentId = find(name)?.parentSpanId;
      return parentId === undefined ? undefined : byId.get(parentId)?.name;
    },
  };
}

async function runOnce() {
  const harness = pipeline([rawProvider({ id: 'raw', invoke: async () => Response.json({ ok: true }) })]);
  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }));
  await response.json();
  await settleRecording(harness.recording);
  return { response, spans: harness.recording.spans };
}

test('parse, session and route spans hang directly under the root span', async () => {
  const { spans } = await runOnce();
  const spanTree = tree(spans);

  expect(spanTree.parentNameOf(spanName.parse)).toBe(spanName.request);
  expect(spanTree.parentNameOf(spanName.session)).toBe(spanName.request);
  expect(spanTree.parentNameOf(spanName.route)).toBe(spanName.request);
});

test('the route span records how many candidates survived capability filtering', async () => {
  const { spans } = await runOnce();

  expect(tree(spans).find(spanName.route)?.attributes[attributeName.routeCandidateCount]).toBe(1);
});

test('a parse failure ends the parse span before the root settles', async () => {
  const harness = pipeline([rawProvider({ id: 'raw' })]);
  const response = await harness.run(jsonRequest({ prompt: 'missing model' }));
  await settleRecording(harness.recording);

  expect(response.status).toBe(400);
  // take() drains the buffer right after root.end(): a parse span that did not
  // get in ahead of that disappears from the trace entirely.
  expect(tree(harness.recording.spans).find(spanName.parse)).toBeDefined();
});

test('a throwing session store still leaves an ended session span behind', async () => {
  const harness = pipeline([rawProvider({ id: 'raw' })]);
  harness.source.logicalSessionStore.begin = () => {
    throw new Error('logical session store unavailable');
  };

  await expect(harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }))).rejects.toThrow(
    'logical session store unavailable',
  );
  await settleRecording(harness.recording);

  // The outer catch settles the root, so an unended session span is dropped on
  // export and the failed request shows no session-resolve segment at all.
  const sessionSpan = tree(harness.recording.spans).find(spanName.session);
  expect(sessionSpan?.endedAt).toBeInstanceOf(Date);
  expect(sessionSpan?.statusCode).toBe(SpanStatusCode.ERROR);
});
