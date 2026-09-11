import { expect, test } from 'bun:test';
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readGrokFile, replaceGrokFile } from './files';

const budget = () => ({ deadline: Date.now() + 5_000, signal: AbortSignal.timeout(5_000) });

test('replaceGrokFile preserves existing mode and rejects an external rewrite before rename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-grok-files-'));
  const path = join(root, 'config.toml');
  try {
    await writeFile(path, 'theme = "dark"\n', { mode: 0o640 });
    const expected = await readGrokFile(path);
    await replaceGrokFile(path, 'theme = "light"\n', expected, budget(), async () => {});
    expect((await Bun.file(path).stat()).mode & 0o777).toBe(0o640);
    expect(await readFile(path, 'utf8')).toBe('theme = "light"\n');
    const again = await readGrokFile(path);
    await expect(
      replaceGrokFile(path, 'theme = "owned"\n', again, budget(), async () => {}, {
        beforeRename: async () => {
          await writeFile(path, 'theme = "external"\n');
        },
      }),
    ).rejects.toThrow(/changed during update/);
    expect(await readFile(path, 'utf8')).toBe('theme = "external"\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readGrokFile distinguishes missing from empty and rejects symlink and hardlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-grok-files-'));
  try {
    const missing = join(root, 'missing.toml');
    expect(await readGrokFile(missing)).toBeUndefined();
    const empty = join(root, 'empty.toml');
    await writeFile(empty, '', { mode: 0o600 });
    const snapshot = await readGrokFile(empty);
    expect(snapshot?.text).toBe('');
    const target = join(root, 'real.toml');
    await writeFile(target, 'ok\n', { mode: 0o600 });
    const linked = join(root, 'link.toml');
    await symlink(target, linked);
    await expect(readGrokFile(linked)).rejects.toThrow(/symlink/);
    const hard = join(root, 'hard.toml');
    await link(target, hard);
    await expect(readGrokFile(target)).rejects.toThrow(/hardlink/);
    await chmod(empty, 0o644);
    expect((await readGrokFile(empty))?.text).toBe('');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
