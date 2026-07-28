import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigSchema } from '@aio-proxy/types';

import packageJson from '../package.json' with { type: 'json' };
import { readOrBootstrapConfig } from '../src/main';

test('bootstrap writes a versioned $schema reference the config schema accepts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-bootstrap-'));
  try {
    const path = join(home, 'config.jsonc');
    await readOrBootstrapConfig(path, 'http://127.0.0.1:22078/dashboard');
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { $schema?: string; server?: { port?: number } };
    expect(parsed.$schema).toBe(`https://cdn.jsdelivr.net/npm/aio-proxy@${packageJson.version}/config.schema.json`);
    expect(parsed.server?.port).toBe(9_317);
    expect(ConfigSchema.safeParse(parsed).success).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
