// bun desktop/scripts/smoke/cli.ts --service <exec>
//
// Installs <exec> as this user's managed service (systemd --user or Task Scheduler) and walks it through
// the app's lifecycle. It replaces any aio-proxy service this account already has: run it on CI runners.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { readDesktopToken } from '../../../packages/core/src/desktop-token';
import { freePort, httpChecks, serviceSmoke, type ServiceSmokeDeps } from './smoke';

// A hung service manager or helper is killed well before the job timeout, so the smoke fails with
// the command that hung instead of a cancelled job.
const SPAWN_LIMITS = { timeout: 60_000, killSignal: 'SIGKILL', windowsHide: true } as const;

async function run(cmd: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<string> {
  // Bun.spawn's default environment does not see assignments to process.env, so pass it explicitly.
  const proc = Bun.spawn([...cmd], {
    ...SPAWN_LIMITS,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}\n${stdout}`);
  // Discovery's report carries the desktop token; serviceSmoke shows it, redacted, only when a wait fails.
  if (!cmd.includes('__desktop-connect')) process.stderr.write(stdout);
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
  return (await Bun.spawn(cmd, { ...SPAWN_LIMITS, stdout: 'ignore', stderr: 'ignore' }).exited) === 0;
}

const { values } = parseArgs({ options: { service: { type: 'string' } } });
if (values.service === undefined) throw new Error('usage: bun desktop/scripts/smoke/cli.ts --service <exec>');
const exec = resolve(values.service);

// A throwaway home on a free loopback port keeps the runner's own config out of it. The unit records
// this home, and discovery falls back to it once the unit is gone.
// Canonical (no 8.3 short names on Windows) so it compares equal to the home the unit records.
const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'aio-proxy-service-smoke-')));
writeFileSync(
  join(home, 'config.jsonc'),
  JSON.stringify({ server: { host: '127.0.0.1', port: freePort() }, providers: {} }),
);
// Bun's fetch honours HTTP_PROXY; the loopback checks must never go through a proxy.
process.env['NO_PROXY'] = process.env['no_proxy'] = '*';

const deps: ServiceSmokeDeps = {
  home,
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
  await run([exec, 'service', 'uninstall'], { AIO_PROXY_HOME: home }).catch(() => {});
  throw error;
} finally {
  // A file the stopped service still holds (EBUSY on Windows) must not replace the smoke's own result.
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  } catch (error) {
    console.warn(`could not remove ${home}: ${String(error)}`);
  }
}
