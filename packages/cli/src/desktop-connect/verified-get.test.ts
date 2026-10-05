import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import { type Run, parseSockets } from './sockets';
import { parseResponse, servesConnection, verifiedGet } from './verified-get';

const run: Run = async (cmd) => {
  const proc = Bun.spawn([...cmd], { stdout: 'pipe', stderr: 'ignore' });
  return { stdout: await new Response(proc.stdout).text(), code: await proc.exited };
};

test("only this user's socket serving this very connection counts", () => {
  const sockets = parseSockets(
    'p1\nu501\nf8\ntIPv4\nn127.0.0.1:55000->127.0.0.1:9317\nf9\ntIPv4\nn127.0.0.1:9317->127.0.0.1:55000\n',
  );
  expect(servesConnection(sockets, '501', '127.0.0.1:9317', '127.0.0.1:55000')).toBe(true);
  // With only our client end visible, another account accepted the connection.
  expect(servesConnection(sockets.slice(0, 1), '501', '127.0.0.1:9317', '127.0.0.1:55000')).toBe(false);
});

test('a chunked or plain HTTP/1.1 response is read whole', () => {
  expect(parseResponse('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}')).toEqual({ status: 200, body: '{}' });
  expect(
    parseResponse('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{"a\r\n4\r\n":1}\r\n0\r\n\r\n'),
  ).toEqual({
    status: 200,
    body: '{"a":1}',
  });
  expect(parseResponse('garbage')).toBeUndefined();
});

// Real-kernel check on both listing sources: lsof on macOS, /proc/net/tcp on Linux (byte order, columns).
test.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  "the bearer is sent to this user's server and withheld when the serving socket is not ours",
  async () => {
    const seen: Array<string | null> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) => {
        seen.push(req.headers.get('authorization'));
        return Response.json({ server: { version: '1', pid: 7 } });
      },
    });
    try {
      const port = String(server.port);
      const uid = process.getuid?.() ?? -1;
      const deps = { run, readFile: (path: string) => readFile(path, 'utf8') };
      const ours = await verifiedGet(process.platform, deps, String(uid), '127.0.0.1', port, '/x', 'secret', 2_000);
      expect(ours?.status).toBe(200);
      expect(JSON.parse(ours?.body ?? '{}')).toEqual({ server: { version: '1', pid: 7 } });
      // Another uid does not hold this connection's serving end (lsof hides other users' sockets, /proc
      // shows them under their own uid), so the check fails and nothing is sent.
      const foreign = await verifiedGet(
        process.platform,
        deps,
        String(uid + 1),
        '127.0.0.1',
        port,
        '/x',
        'secret',
        300,
      );
      expect(foreign).toBeUndefined();
      expect(seen).toEqual(['Bearer secret']);
    } finally {
      await server.stop(true);
    }
  },
);

test.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'a finished request leaves no timer holding the process until the deadline',
  async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({}) });
    try {
      const uid = process.getuid?.() ?? -1;
      const child = Bun.spawn(
        [
          process.execPath,
          '-e',
          `const { readFile } = await import('node:fs/promises');
           const { verifiedGet } = await import(${JSON.stringify(`${import.meta.dir}/verified-get.ts`)});
           const run = async (cmd) => { const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' }); return { stdout: await new Response(p.stdout).text(), code: await p.exited }; };
           const res = await verifiedGet(process.platform, { run, readFile: (p) => readFile(p, 'utf8') }, '${uid}', '127.0.0.1', '${server.port}', '/x', 't', 10000);
           if (res?.status !== 200) process.exit(2);`,
        ],
        { stdout: 'ignore', stderr: 'inherit' },
      );
      const started = Date.now();
      expect(await child.exited).toBe(0);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await server.stop(true);
    }
  },
);
