import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const freePort = (): number => {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
};

async function waitForHealth(base: string, deadline: number): Promise<{ version?: string }> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return (await response.json()) as { version?: string };
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`${base}/health never answered`);
}

const expectStatus = async (label: string, response: Response, status: number): Promise<Response> => {
  if (response.status !== status) throw new Error(`${label}: HTTP ${response.status}, expected ${status}`);
  return response;
};

/**
 * Runs the bundled sidecar with a throwaway home on a free port and no user tools on PATH, checks
 * what the app depends on, then SIGTERMs it. It never installs a launchd job.
 */
export async function runtimeSmoke(app: string, version: string): Promise<void> {
  // Bun's fetch honours HTTP_PROXY; the loopback checks below must never go through a proxy.
  process.env.NO_PROXY = '*';
  process.env.no_proxy = '*';
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-smoke-'));
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const proxy = Bun.spawn([join(app, 'Contents/MacOS/aio-proxy'), 'run', '--port', String(port)], {
    env: { PATH: '/usr/bin:/bin', HOME: home, AIO_PROXY_HOME: home, NO_PROXY: '*', no_proxy: '*' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  try {
    const health = await waitForHealth(base, Date.now() + 30_000);
    if (health.version !== version) throw new Error(`/health reports ${health.version}, bundle is ${version}`);
    const html = await (await expectStatus('/dashboard', await fetch(`${base}/dashboard`), 200)).text();
    const asset = /(?:src|href)="(\/dashboard\/static\/[^"]+)"/u.exec(html)?.[1];
    if (asset === undefined) throw new Error('/dashboard HTML references no static asset');
    await expectStatus(asset, await fetch(`${base}${asset}`), 200);
    const token = (await Bun.file(join(home, 'desktop-token')).text()).trim();
    await expectStatus(
      'desktop-summary',
      await fetch(`${base}/dashboard/api/desktop-summary`, { headers: { authorization: `Bearer ${token}` } }),
      200,
    );
  } finally {
    proxy.kill('SIGTERM');
    await proxy.exited;
    rmSync(home, { recursive: true, force: true });
  }
}
