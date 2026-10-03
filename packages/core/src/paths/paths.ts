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
 *
 * `bun test` sets `NODE_ENV=test`. Under it, resolving to the real
 * `~/.aio-proxy` throws: a test that writes there poisons the developer's live
 * cache, database, and config, and bunfig preloads only isolate runs launched
 * from a package root.
 */
export function aioHome(): string {
  const env = process.env as { readonly AIO_PROXY_HOME?: string; readonly NODE_ENV?: string };
  const realHome = join(homedir(), '.aio-proxy');
  const home = env.AIO_PROXY_HOME === undefined || env.AIO_PROXY_HOME === '' ? realHome : env.AIO_PROXY_HOME;
  if (env.NODE_ENV === 'test' && home === realHome) {
    throw new Error(
      `Refusing to use the real aio-proxy home (${realHome}) under test. Run the package's test:unit script or set AIO_PROXY_HOME to a temp dir.`,
    );
  }
  return home;
}

export function configPathIn(home: string): string {
  return CONFIG_FILE_NAMES.map((name) => join(home, name)).find(existsSync) ?? join(home, 'config.jsonc');
}

export function configPath(): string {
  return configPathIn(aioHome());
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
