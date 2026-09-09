import { expect, test } from 'bun:test';

import { configureCodexAgent } from './codex';

test('rejects restore migration identifiers before touching Codex storage', async () => {
  await expect(configureCodexAgent({ restoreMigration: 'not-a-uuid' })).rejects.toThrow(
    'migration operation id must be a UUID',
  );
});

test('returns a non-interactive result before probing the Codex executable', async () => {
  const result = await configureCodexAgent();
  expect(result).toMatchObject({ target: 'codex', status: 'cancelled', reason: 'non_interactive' });
});
