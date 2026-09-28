import { expect, test } from 'bun:test';

import type { AgentOperationState } from '@aio-proxy/types';

import { AgentOperationBusyError, createAgentOperations } from './operations';

test('server shutdown cancels unfinished operations and refuses new ones', async () => {
  const shutdown = new AbortController();
  const operations = createAgentOperations({
    shutdown: shutdown.signal,
    run: (_request, events) =>
      new Promise((_, reject) => {
        events.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    resolveDevice: () => undefined,
    onUnknownError: () => undefined,
  });
  const started = operations.start({ kind: 'configure', target: 'opencode' });
  expect(started.status).toBe('running');

  shutdown.abort();
  await operations.settled();
  expect(operations.get(started.operationId)).toMatchObject({
    status: 'failed',
    error: 'cancelled',
  } satisfies Partial<AgentOperationState>);
  expect(() => operations.start({ kind: 'remove', target: 'grok' })).toThrow(AgentOperationBusyError);
});
