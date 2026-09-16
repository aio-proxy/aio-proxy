import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_FILE_NAMES = ['config.yml', 'config.yaml', 'config.jsonc', 'config.json'] as const;

/**
 * Single source of truth for the `~/.aio-proxy` filesystem layout.
 *
 * `AIO_PROXY_HOME` overrides the root. Both `undefined` and empty string are
 * treated as absent — an empty override falls back to `~/.aio-proxy` rather
 * than resolving paths against the current directory.
 */
export function aioHome(): string {
  const home = (process.env as { readonly AIO_PROXY_HOME?: string }).AIO_PROXY_HOME;
  return home === undefined || home === '' ? join(homedir(), '.aio-proxy') : home;
}

export function configPath(): string {
  const home = aioHome();
  return CONFIG_FILE_NAMES.map((name) => join(home, name)).find(existsSync) ?? join(home, 'config.jsonc');
}

export function dbPath(): string {
  return join(aioHome(), 'aio-proxy.db');
}

export function packagesDir(): string {
  return join(aioHome(), 'packages');
}

export function tmpDir(): string {
  return join(aioHome(), 'tmp');
}

export function updateCheckPath(): string {
  return join(aioHome(), 'update-check.json');
}

/**
 * Device-local key used to sign Dashboard sessions. Deliberately a file under `~/.aio-proxy`
 * rather than anything derived from config: the configuration is what sync publishes, and a
 * session signing key that travelled to a backend would let a read-only breach mint tokens.
 */
export function sessionKeyPath(): string {
  return join(aioHome(), 'session-key');
}
