import { expect, test } from 'bun:test';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { grokPaths, isGrokOwnedTmpName, readGrokFile, removeGrokOwnedTemporaryFiles, replaceGrokFile } from './files';
import { MAX_GROK_FILE_BYTES } from './read-bounded';

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

test('owned tmp names are sibling aio uuid files and leftover tmp is removed without touching unknown files', async () => {
  const tmpName = `ownership.json.aio-${crypto.randomUUID()}`;
  expect(isGrokOwnedTmpName(tmpName, 'ownership.json')).toBe(true);
  expect(isGrokOwnedTmpName('notes.txt', 'ownership.json')).toBe(false);
  expect(isGrokOwnedTmpName('ownership.json.aio-not-a-uuid', 'ownership.json')).toBe(false);
  const root = await mkdtemp(join(tmpdir(), 'aio-grok-tmp-'));
  try {
    const paths = grokPaths(root);
    await mkdir(paths.privateDir, { mode: 0o700 });
    const leftover = join(paths.privateDir, tmpName);
    await writeFile(leftover, 'tmp\n', { mode: 0o600 });
    await writeFile(join(paths.privateDir, 'notes.txt'), 'keep\n', { mode: 0o600 });
    const configTmp = join(root, `config.toml.aio-${crypto.randomUUID()}`);
    await writeFile(configTmp, 'cfg-tmp\n', { mode: 0o600 });
    await removeGrokOwnedTemporaryFiles(paths);
    expect(await Bun.file(leftover).exists()).toBe(false);
    expect(await Bun.file(configTmp).exists()).toBe(false);
    expect(await readFile(join(paths.privateDir, 'notes.txt'), 'utf8')).toBe('keep\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an oversized Grok file is unverifiable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-grok-oversize-'));
  const path = join(root, 'config.toml');
  try {
    await writeFile(path, `[ui]\ntheme = "${'a'.repeat(MAX_GROK_FILE_BYTES)}"\n`, { mode: 0o600 });
    const started = Date.now();
    await expect(readGrokFile(path)).rejects.toThrow(/unverifiable/i);
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an expired Grok file budget is unverifiable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-grok-expired-'));
  const path = join(root, 'config.toml');
  try {
    await writeFile(path, '[ui]\ntheme = "dark"\n', { mode: 0o600 });
    await expect(readGrokFile(path, { deadline: Date.now() - 1, signal: AbortSignal.timeout(5_000) })).rejects.toThrow(
      /unverifiable/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
