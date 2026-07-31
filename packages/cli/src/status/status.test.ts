import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StatusNotRunningError } from '../errors';
import { statusCommand } from './status';

test('status reports running + version from /health', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ status: 'ok', uptime: 1, version: '1.2.3' }),
  });
  try {
    const lines: string[] = [];
    await statusCommand({ port: String(server.port) }, (l) => lines.push(l));
    const out = lines.join('\n');
    expect(out).toContain('1.2.3');
    expect(out).toContain(String(server.port));
  } finally {
    server.stop(true);
  }
});

test('status prints the result then throws so an unreachable daemon exits nonzero', async () => {
  // Reserve then release a port so nothing is listening.
  const probe = Bun.serve({ port: 0, fetch: () => new Response('x') });
  const deadPort = probe.port;
  probe.stop(true);

  const lines: string[] = [];
  // The human-readable result must still be printed before the throw...
  let caught: unknown;
  await statusCommand({ port: String(deadPort) }, (l) => lines.push(l)).catch((err) => {
    caught = err;
  });
  expect(lines.join('\n')).toContain(String(deadPort));
  // ...and the command must signal "down" so the exit code is nonzero (transient),
  // letting a health check tell an unreachable daemon apart from a running one.
  expect(caught).toBeInstanceOf(StatusNotRunningError);
});

test('--json still emits the machine result before signaling a down daemon', async () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('x') });
  const deadPort = probe.port;
  probe.stop(true);

  const lines: string[] = [];
  let caught: unknown;
  await statusCommand({ port: String(deadPort), json: true }, (l) => lines.push(l)).catch((err) => {
    caught = err;
  });
  const parsed = JSON.parse(lines.join('\n')) as { running: boolean };
  expect(parsed.running).toBe(false);
  expect(caught).toBeInstanceOf(StatusNotRunningError);
});

test('--deep notes the limitation when the providers endpoint is password-gated', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/health') return Response.json({ status: 'ok', uptime: 1, version: '1.2.3' });
      // provider probe endpoint is auth-gated → 401
      return new Response('Unauthorized', { status: 401 });
    },
  });
  try {
    const lines: string[] = [];
    await statusCommand({ port: String(server.port), deep: true }, (l) => lines.push(l));
    const out = lines.join('\n');
    expect(out).toContain('1.2.3');
    expect(out.toLowerCase()).toContain('password');
  } finally {
    server.stop(true);
  }
});

test('--deep reports a generic probe failure for non-auth errors', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/health') return Response.json({ status: 'ok', uptime: 1, version: '1.2.3' });
      // Not auth-gated: a 500 must NOT be reported as password-gated.
      return new Response('boom', { status: 500 });
    },
  });
  try {
    const lines: string[] = [];
    await statusCommand({ port: String(server.port), deep: true }, (l) => lines.push(l));
    const out = lines.join('\n');
    expect(out).toContain('500');
    expect(out.toLowerCase()).not.toContain('password');
  } finally {
    server.stop(true);
  }
});

test('--deep --json distinguishes an auth failure from a generic probe failure', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/health') return Response.json({ status: 'ok', uptime: 1, version: '1.2.3' });
      return new Response('nope', { status: 403 });
    },
  });
  try {
    const lines: string[] = [];
    await statusCommand({ port: String(server.port), deep: true, json: true }, (l) => lines.push(l));
    const parsed = JSON.parse(lines.join('\n')) as { deepFailure?: { reason: string } };
    expect(parsed.deepFailure?.reason).toBe('auth');
  } finally {
    server.stop(true);
  }
});

test('status honors a config-only port when no --port flag is given', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ status: 'ok', uptime: 1, version: '9.9.9' }),
  });
  const home = mkdtempSync(join(tmpdir(), 'aio-status-'));
  const prev = process.env.AIO_PROXY_HOME;
  process.env.AIO_PROXY_HOME = home;
  try {
    // A managed run binds the config port; a bare `status` (no flags) must probe
    // that port, not the hard-coded 9317, or it wrongly reports the daemon down.
    writeFileSync(join(home, 'config.jsonc'), `{ "server": { "port": ${server.port} }, "providers": {} }\n`);
    const lines: string[] = [];
    await statusCommand({}, (l) => lines.push(l));
    const out = lines.join('\n');
    expect(out).toContain('9.9.9');
    expect(out).toContain(String(server.port));
  } finally {
    if (prev === undefined) delete process.env.AIO_PROXY_HOME;
    else process.env.AIO_PROXY_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    server.stop(true);
  }
});
