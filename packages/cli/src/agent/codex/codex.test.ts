import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { configureCodexAgent, recoverPendingCodexOperations, runCodexAuthCommand } from './codex';

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

test('rejects an invalid helper installation UUID before reading credentials', async () => {
  await expect(runCodexAuthCommand('not-a-uuid')).rejects.toThrow('Codex installation id must be a UUID');
});

test('enforces the helper startup budget before reading credentials', async () => {
  await expect(runCodexAuthCommand('11111111-1111-4111-8111-111111111111', Date.now() - 5_000)).rejects.toThrow(
    'CODEX_AUTH_TIMEOUT',
  );
});

test('requires an independent decision before recovering a pending auth journal', async () => {
  let authRecoveryCalls = 0;
  const answers = [true, false];
  let confirmationCalls = 0;
  const result = await recoverPendingCodexOperations(
    async (confirm) => {
      await confirm();
      return 'recovered';
    },
    true,
    async () => {
      confirmationCalls += 1;
      const answer = answers.shift()!;
      return answer;
    },
    async () => {
      authRecoveryCalls += 1;
      return 'completed';
    },
  );
  expect(result).toBe('cancelled');
  expect(confirmationCalls).toBe(2);
  expect(authRecoveryCalls).toBe(0);
});
