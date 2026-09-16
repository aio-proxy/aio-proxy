import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseProbeResult, swapInstallation } from './probe-installed';

describe('installed CloudKit probe output', () => {
  test('accepts only the redacted success contract', () => {
    expect(
      parseProbeResult(
        JSON.stringify({
          ok: true,
          account: 'available',
          identityId: `sha256:${'a'.repeat(64)}`,
          bundleId: 'dev.aioproxy',
        }),
      ),
    ).toEqual({
      ok: true,
      account: 'available',
      identityId: `sha256:${'a'.repeat(64)}`,
      bundleId: 'dev.aioproxy',
    });
  });

  test('rejects native output that contains an unstructured error', () => {
    expect(() => parseProbeResult('{"ok":false,"error":"secret"}')).toThrow('structured probe error');
  });

  test('rejects a raw account identity instead of treating it as an opaque hash', () => {
    expect(() =>
      parseProbeResult(
        '{"ok":true,"account":"available","identityId":"sha256:alice@example.com","bundleId":"dev.aioproxy"}',
      ),
    ).toThrow('success response');
  });

  test('restores the previous installation if the atomic swap fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aio-cloudkit-swap-'));
    const previous = join(root, 'version');
    const staged = join(root, 'staged');
    await mkdir(previous);
    await mkdir(staged);
    await writeFile(join(previous, 'marker'), 'previous');
    await writeFile(join(staged, 'marker'), 'new');
    let calls = 0;
    const failingRename = async (from: string, to: string) => {
      calls += 1;
      if (calls === 2) throw new Error('injected swap failure');
      await rename(from, to);
    };
    await expect(swapInstallation(staged, previous, failingRename)).rejects.toThrow('injected swap failure');
    expect(await readFile(join(previous, 'marker'), 'utf8')).toBe('previous');
  });
});
