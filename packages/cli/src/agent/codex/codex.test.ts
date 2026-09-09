import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { configureCodexAgent } from './codex';

test('rejects restore migration identifiers before touching Codex storage', async () => {
  await expect(configureCodexAgent({ restoreMigration: 'not-a-uuid' })).rejects.toThrow(
    'migration operation id must be a UUID',
  );
});

test('returns a non-interactive result before probing the Codex executable', async () => {
  const previousCodexHome = process.env['CODEX_HOME'];
  delete process.env['CODEX_HOME'];
  try {
    const result = await configureCodexAgent();
    expect(result).toMatchObject({ target: 'codex', status: 'cancelled', reason: 'non_interactive' });
    expect(result.configPath).toBe(join(homedir(), '.codex', 'config.toml'));
  } finally {
    if (previousCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previousCodexHome;
  }
});
