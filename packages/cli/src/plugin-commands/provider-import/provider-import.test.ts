import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { OAuthCredentialImportUnsupportedError, ProviderAccountAlreadyExistsError } from '@aio-proxy/core';

import { CliExit } from '../../exit';
import { type ProviderImportDeps, providerImport } from './provider-import';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'aio-provider-import-'));
  roots.push(root);
  return root;
}

function write(root: string, name: string, contents: string): string {
  const path = join(root, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function snapshot(paths: readonly string[]): Map<string, Buffer> {
  return new Map(paths.map((path) => [path, readFileSync(path)]));
}

function assertUnchanged(originals: Map<string, Buffer>): void {
  for (const [path, bytes] of originals) {
    expect(readFileSync(path)).toEqual(bytes);
  }
}

function createDeps(overrides: Partial<ProviderImportDeps> = {}): ProviderImportDeps & {
  readonly printed: string[];
  readonly imported: unknown[];
  recoverCalls: number;
  closes: number;
} {
  const printed: string[] = [];
  const imported: unknown[] = [];
  const state = {
    printed,
    imported,
    recoverCalls: 0,
    closes: 0,
    config: {} as ProviderImportDeps['config'],
    repository: {} as ProviderImportDeps['repository'],
    registry: {} as ProviderImportDeps['registry'],
    diagnostics: {} as ProviderImportDeps['diagnostics'],
    logger: () => {},
    recover: async () => {
      state.recoverCalls += 1;
      return {};
    },
    importAccount: async (options: { type: string }) => {
      imported.push(options);
      const { type } = options;
      if (type === 'duplicate') throw new ProviderAccountAlreadyExistsError('existing-provider');
      if (type === 'unsupported') throw new OAuthCredentialImportUnsupportedError('cpa', type);
      if (type === 'broken') throw new Error('credential conversion failed PLANTED_SECRET');
      return { providerId: `provider-${type}` };
    },
    cwd: () => {
      throw new Error('cwd should not be used');
    },
    print: (line: string) => {
      printed.push(line);
    },
    close: () => {
      state.closes += 1;
    },
    ...overrides,
  };
  return state;
}

describe('provider import file discovery', () => {
  test('omitted path uses cwd and imports immediate json files in lexical order', async () => {
    const root = tempDir();
    const a = write(root, 'a.json', '{"type":"alpha"}');
    const b = write(root, 'b.json', '{"type":"beta"}');
    const nested = write(root, 'nested/c.json', '{"type":"nested"}');
    const ignored = write(root, 'ignored.txt', '{"type":"ignored"}');
    const originals = snapshot([a, b, nested, ignored]);
    const deps = createDeps({ cwd: () => root });

    await providerImport(undefined, deps);

    expect(deps.recoverCalls).toBe(1);
    expect(deps.closes).toBe(0);
    expect(deps.imported.map((entry) => (entry as { type: string }).type)).toEqual(['alpha', 'beta']);
    expect(deps.printed).toEqual([
      `Imported ${a} as provider provider-alpha`,
      `Imported ${b} as provider provider-beta`,
      'Import summary: imported 2, duplicate 0, skipped 0, failed 0',
    ]);
    assertUnchanged(originals);
  });

  test('imports a supplied file regardless of extension', async () => {
    const root = tempDir();
    const file = write(root, 'auth.data', '{"type":"auth"}');
    const originals = snapshot([file]);
    const deps = createDeps();

    await providerImport(file, deps);

    expect(deps.imported).toHaveLength(1);
    expect((deps.imported[0] as { type: string }).type).toBe('auth');
    expect(deps.printed).toEqual([
      `Imported ${file} as provider provider-auth`,
      'Import summary: imported 1, duplicate 0, skipped 0, failed 0',
    ]);
    assertUnchanged(originals);
  });

  test('supplied missing path throws CliExit 1 without opening dependencies', async () => {
    const missing = join(tempDir(), 'missing.json');
    const deps = createDeps();

    const injected = await providerImport(missing, deps).catch((error: unknown) => error);
    expect(injected).toBeInstanceOf(CliExit);
    expect((injected as CliExit).code).toBe(1);
    expect((injected as CliExit).message).toBe(`Import path does not exist: ${resolve(missing)}`);
    expect(deps.recoverCalls).toBe(0);
    expect(deps.imported).toEqual([]);
    expect(deps.closes).toBe(0);
    expect(deps.printed).toEqual([]);

    const uninjected = await providerImport(missing).catch((error: unknown) => error);
    expect(uninjected).toBeInstanceOf(CliExit);
    expect((uninjected as CliExit).code).toBe(1);
    expect((uninjected as CliExit).message).toBe(`Import path does not exist: ${resolve(missing)}`);
  });

  test('empty directory prints all-zero summary and succeeds', async () => {
    const root = tempDir();
    const deps = createDeps();

    await providerImport(root, deps);

    expect(deps.recoverCalls).toBe(1);
    expect(deps.closes).toBe(0);
    expect(deps.imported).toEqual([]);
    expect(deps.printed).toEqual(['Import summary: imported 0, duplicate 0, skipped 0, failed 0']);
  });
});

describe('provider import outcomes', () => {
  test('classifies each file once and exits 1 after summary when any file failed', async () => {
    const root = tempDir();
    const imported = write(root, 'a-ok.json', '{"type":"ok","access_token":"SECRET_TOKEN_VALUE"}');
    const duplicate = write(root, 'b-duplicate.json', '{"type":"duplicate"}');
    const skipped = write(root, 'c-unsupported.json', '{"type":"unsupported"}');
    const invalid = write(root, 'd-invalid.json', '{not-json');
    const missingType = write(root, 'e-missing-type.json', '{"access_token":"SECRET_TOKEN_VALUE"}');
    const originals = snapshot([imported, duplicate, skipped, invalid, missingType]);
    const deps = createDeps();

    const error = await providerImport(root, deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliExit);
    expect((error as CliExit).code).toBe(1);
    expect((error as CliExit).message).toBe('');
    expect(deps.recoverCalls).toBe(1);
    expect(deps.closes).toBe(0);
    expect(deps.imported.map((entry) => (entry as { type: string }).type)).toEqual(['ok', 'duplicate', 'unsupported']);
    expect(deps.printed).toEqual([
      `Imported ${imported} as provider provider-ok`,
      `Skipped duplicate ${duplicate}; provider existing-provider already exists`,
      `Skipped ${skipped}: unsupported auth type "unsupported"`,
      `Failed ${invalid}: invalid JSON`,
      `Failed ${missingType}: missing or invalid top-level type`,
      'Import summary: imported 1, duplicate 1, skipped 1, failed 2',
    ]);
    expect(deps.printed.join('\n')).not.toContain('SECRET_TOKEN_VALUE');
    assertUnchanged(originals);
  });

  test('whitespace-padded supported type reaches importAccount as canonical', async () => {
    const root = tempDir();
    const file = write(root, 'padded.json', '{"type":"  ok  "}');
    const originals = snapshot([file]);
    const deps = createDeps();

    await providerImport(file, deps);

    expect(deps.imported).toHaveLength(1);
    const entry = deps.imported[0] as { type: string; raw: { type: string } };
    expect(entry.type).toBe('ok');
    expect(entry.raw.type).toBe('ok');
    expect(deps.printed).toEqual([
      `Imported ${file} as provider provider-ok`,
      'Import summary: imported 1, duplicate 0, skipped 0, failed 0',
    ]);
    assertUnchanged(originals);
  });

  test('conversion failure increments failed without printing the error secret', async () => {
    const root = tempDir();
    const file = write(root, 'broken.json', '{"type":"broken"}');
    const originals = snapshot([file]);
    const deps = createDeps();

    const error = await providerImport(root, deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliExit);
    expect((error as CliExit).code).toBe(1);
    expect((error as CliExit).message).toBe('');
    expect(deps.printed).toEqual([
      `Failed ${file}: credential import failed`,
      'Import summary: imported 0, duplicate 0, skipped 0, failed 1',
    ]);
    expect(deps.printed.join('\n')).not.toContain('PLANTED_SECRET');
    assertUnchanged(originals);
  });
});
