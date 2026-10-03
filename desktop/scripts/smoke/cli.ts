// bun desktop/scripts/smoke/cli.ts --service <exec>
//
// Installs <exec> as this user's managed service (systemd --user or Task Scheduler) and walks it through
// the app's lifecycle. It replaces any aio-proxy service this account already has: run it on CI runners.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { readDesktopToken } from '../../../packages/core/src/desktop-token';
import { freePort, httpChecks, serviceSmoke, type ServiceSmokeDeps } from './smoke';

async function run(cmd: readonly string[]): Promise<string> {
  const proc = Bun.spawn([...cmd], { stdout: 'pipe', stderr: 'inherit', windowsHide: true });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}\n${stdout}`);
  process.stderr.write(stdout);
  return stdout;
}

async function processRemains(): Promise<boolean> {
  const cmd =
    process.platform === 'win32'
      ? [
          'powershell',
          '-NoProfile',
          '-Command',
          'if (Get-Process aio-proxy -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }',
        ]
      : ['pgrep', '-x', 'aio-proxy'];
  return (await Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore', windowsHide: true }).exited) === 0;
}

const { values } = parseArgs({ options: { service: { type: 'string' } } });
if (values.service === undefined) throw new Error('usage: bun desktop/scripts/smoke/cli.ts --service <exec>');
const exec = resolve(values.service);

// A throwaway home on a free loopback port keeps the runner's own config out of it. The unit records
// this home, and discovery falls back to it once the unit is gone.
const home = mkdtempSync(join(tmpdir(), 'aio-proxy-service-smoke-'));
writeFileSync(
  join(home, 'config.jsonc'),
  JSON.stringify({ server: { host: '127.0.0.1', port: freePort() }, providers: {} }),
);
process.env['AIO_PROXY_HOME'] = home;
// Installed the way the desktop app installs it, so the unit and discovery see a desktop-owned service.
process.env['AIO_PROXY_DESKTOP_EXEC'] = exec;
// Bun's fetch honours HTTP_PROXY; the loopback checks must never go through a proxy.
process.env['NO_PROXY'] = process.env['no_proxy'] = '*';

const deps: ServiceSmokeDeps = {
  run,
  httpChecks: async (base) => {
    const token = readDesktopToken(home);
    if (token === undefined) throw new Error(`no readable desktop token for ${home}`);
    await httpChecks(base, token);
  },
  processRemains,
  sleep: Bun.sleep,
  now: Date.now,
};

try {
  await serviceSmoke(exec, deps);
  console.log('service smoke passed');
} catch (error) {
  await run([exec, 'service', 'uninstall']).catch(() => {});
  throw error;
} finally {
  rmSync(home, { recursive: true, force: true });
}
