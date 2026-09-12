import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCodexLocation } from '../../location';
import { readAuthOperation } from './journal';

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-auth-journal-'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  return { root, location: resolveCodexLocation(root, { HOME: root }) };
};

test('rejects a configure keep-chatgpt journal that invents an installation id', async () => {
  const { root, location } = await fixture();
  try {
    await mkdir(location.managedRoot, { recursive: true, mode: 0o700 });
    await Bun.write(
      join(location.managedRoot, 'codex-auth-operation.json'),
      `${JSON.stringify({
        format: 1,
        operationId: crypto.randomUUID(),
        configPath: location.configPath,
        kind: 'configure',
        targetMode: 'keep-chatgpt',
        phase: 'prepared',
        installationId: crypto.randomUUID(),
        providerId: 'aio-proxy',
      })}\n`,
    );
    await expect(readAuthOperation(location)).rejects.toThrow(/invalid/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a non-object authentication journal', async () => {
  const { root, location } = await fixture();
  try {
    await mkdir(location.managedRoot, { recursive: true, mode: 0o700 });
    await Bun.write(join(location.managedRoot, 'codex-auth-operation.json'), '[1]\n');
    await expect(readAuthOperation(location)).rejects.toThrow(/invalid/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
