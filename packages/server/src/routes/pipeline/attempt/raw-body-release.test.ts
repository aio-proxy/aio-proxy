import { describe, expect, test } from 'bun:test';

import { releaseInvokedRawBodies } from './raw';

function unreadTeePair(): { retrySource: Request; upstream: Request } {
  const upstream = new Request('https://proxy.example/v1/responses', {
    body: new ReadableStream({
      pull() {
        // Keep both tee branches unread so cancel waits on the sibling.
      },
    }),
    duplex: 'half',
    method: 'POST',
  });
  return { retrySource: upstream.clone(), upstream };
}

describe('releaseInvokedRawBodies', () => {
  test('cancels unread cloned request bodies concurrently', async () => {
    const { retrySource, upstream } = unreadTeePair();

    const outcome = await Promise.race([
      releaseInvokedRawBodies(upstream, retrySource, new Error('release')),
      Bun.sleep(1000).then(() => 'timed-out' as const),
    ]);

    expect(outcome).not.toBe('timed-out');
  });
});
