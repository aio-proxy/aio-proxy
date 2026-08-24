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

test.each([404, 500])('rejects revoke HTTP %s without fabricating a terminal status', async (status) => {
  await expect(
    revokeAgentInstallation('http://127.0.0.1:9317', INSTALLATION, async () => new Response('', { status })),
  ).rejects.toThrow();
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
