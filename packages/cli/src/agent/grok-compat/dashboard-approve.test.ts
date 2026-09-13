import { expect, test } from 'bun:test';

import { approveDashboardAuthorization } from './dashboard-approve';

test('approveDashboardAuthorization fails within the signal when login hangs', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
  try {
    const started = Date.now();
    await expect(
      approveDashboardAuthorization({
        endpoint: server.url.origin,
        password: 'x',
        verificationUrl: `${server.url.origin}/dashboard/agents/authorize#code=ABCD-EFGH`,
        signal: AbortSignal.timeout(80),
      }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    server.stop();
  }
});
