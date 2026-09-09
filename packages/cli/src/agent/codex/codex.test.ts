import { expect, test } from 'bun:test';

import { configureCodexAgent } from './codex';

test('rejects restore migration identifiers before touching Codex storage', async () => {
  await expect(configureCodexAgent({ restoreMigration: 'not-a-uuid' })).rejects.toThrow(
    'migration operation id must be a UUID',
  );
});
