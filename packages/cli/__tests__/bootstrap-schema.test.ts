import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigSchema } from '@aio-proxy/types';

import { readOrBootstrapConfig } from '../src/main';

test('bootstrap writes an unpinned $schema reference the config schema accepts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-bootstrap-'));
  try {
    const path = join(home, 'config.jsonc');
    await readOrBootstrapConfig(path, 'http://127.0.0.1:22078/dashboard');
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { $schema?: string; server?: { port?: number } };
    // Unpinned on purpose: nothing rewrites this line after bootstrap, so a
    // version would rot. See CONFIG_SCHEMA_URL in src/run/run.ts.
    expect(parsed.$schema).toBe('https://unpkg.com/@aio-proxy/types/config.schema.json');
    expect(parsed.server?.port).toBe(9_317);
    expect(ConfigSchema.safeParse(parsed).success).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
