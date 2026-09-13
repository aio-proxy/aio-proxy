import { expect, test } from 'bun:test';

import { connectHost, readAgentAdminSnapshot, revokeAgentInstallation } from './control-plane';

const INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';

test('snapshot validates capabilities and sends no Agent credential', async () => {
  const calls: Request[] = [];
  const snapshot = await readAgentAdminSnapshot('http://127.0.0.1:9317', async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    return Response.json({ installations: [], deviceAuthorization: 'available', catalogSchemaVersions: [1] });
  });
  expect(snapshot).toEqual({ installations: [], deviceAuthorization: 'available', catalogSchemaVersions: [1] });
  expect(calls[0]!.url).toBe('http://127.0.0.1:9317/admin/agent-installations');
  expect(calls[0]!.headers.get('authorization')).toBeNull();
});

test.each(['revoked', 'expired', 'missing'] as const)('accepts revoke terminal %s', async (status) => {
  await expect(
    revokeAgentInstallation('http://127.0.0.1:9317', INSTALLATION, async () =>
      Response.json({ installationId: INSTALLATION, status }),
    ),
  ).resolves.toBe(status);
});

test('rejects a revoke terminal for a different installation', async () => {
  await expect(
    revokeAgentInstallation('http://127.0.0.1:9317', INSTALLATION, async () =>
      Response.json({ installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'revoked' }),
    ),
  ).rejects.toThrow();
});

test('revoke fetch honors the remaining operation budget', async () => {
  const started = Date.now();
  await expect(
    revokeAgentInstallation(
      'http://127.0.0.1:9317',
      INSTALLATION,
      (_input, init) =>
        new Promise((_, reject) => {
          const signal = init?.signal;
          if (signal === undefined) return;
          const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
          signal.addEventListener('abort', fail, { once: true });
          if (signal.aborted) fail();
        }),
      { deadline: Date.now() + 80, signal: AbortSignal.timeout(80) },
    ),
  ).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(1_000);
});

test.each([404, 500])('rejects revoke HTTP %s without fabricating a terminal status', async (status) => {
  await expect(
    revokeAgentInstallation('http://127.0.0.1:9317', INSTALLATION, async () => new Response('', { status })),
  ).rejects.toThrow();
});

test('rejects revoke redirects instead of following them to another origin', async () => {
  let redirect: RequestRedirect | undefined;
  await expect(
    revokeAgentInstallation('http://127.0.0.1:9317', INSTALLATION, async (input, init) => {
      redirect = init?.redirect;
      expect(String(input instanceof Request ? input.url : input)).toBe(
        `http://127.0.0.1:9317/admin/agent-installations/${INSTALLATION}/revoke`,
      );
      return Response.json(
        { installationId: INSTALLATION, status: 'revoked' },
        { status: 307, headers: { location: 'http://evil.test/revoke' } },
      );
    }),
  ).rejects.toThrow();
  expect(redirect).toBe('error');
});

test.each(['127.example.test', '127.0.0.999', '127.1', '192.0.2.10'])(
  'rejects non-canonical/non-loopback host %s',
  (host) => expect(() => connectHost(host)).toThrow('loopback'),
);

test.each([
  ['0.0.0.0', '127.0.0.1'],
  ['*', '127.0.0.1'],
  ['::', '::1'],
  ['localhost', 'localhost'],
  ['127.255.255.254', '127.255.255.254'],
  ['::1', '::1'],
  ['[::1]', '::1'],
] as const)('maps accepted host %s to %s', (host, expected) => {
  expect(connectHost(host)).toBe(expected);
});
