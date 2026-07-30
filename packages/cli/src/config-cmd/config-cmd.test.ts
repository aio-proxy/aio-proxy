import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigValidationError } from '../errors';
import { configEdit, configPathCommand, configShow, configValidate } from './config-cmd';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aio-cfg-'));
  prevHome = process.env.AIO_PROXY_HOME;
  process.env.AIO_PROXY_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

test('show redacts secret-like values and keeps comments out of the parsed output', async () => {
  writeFileSync(
    join(home, 'config.jsonc'),
    '{ /* comment */ "server": { "port": 9317, "password": "s3cr3t" }, "providers": {} }\n',
  );
  const lines: string[] = [];
  await configShow({}, (l) => lines.push(l));
  const out = lines.join('\n');
  expect(out).not.toContain('s3cr3t');
});

test('validate resolves for a valid config', async () => {
  writeFileSync(join(home, 'config.jsonc'), '{ "server": { "port": 9317 }, "providers": {} }\n');
  const lines: string[] = [];
  await expect(configValidate(undefined, (l) => lines.push(l))).resolves.toBeUndefined();
  expect(lines.join('\n')).toContain('valid');
});

test('validate throws a user-facing error for malformed config', async () => {
  writeFileSync(join(home, 'config.jsonc'), '{ "server": { "port": "not-a-number" }, "providers": {} }\n');
  let caught: unknown;
  await configValidate(undefined, () => {}).catch((err) => {
    caught = err;
  });
  expect(caught).toBeInstanceOf(ConfigValidationError);
});

test('validate reports syntax errors as a user-facing validation error', async () => {
  // Invalid JSONC (unclosed brace) makes AtomicConfigFile.read() throw before
  // parseRuntimeConfig runs; it must still surface as ConfigValidationError so
  // the exit-code contract classifies it unrecoverable (1), not transient (2).
  writeFileSync(join(home, 'config.jsonc'), '{ "server": { "port": 9317 ');
  let caught: unknown;
  await configValidate(undefined, () => {}).catch((err) => {
    caught = err;
  });
  expect(caught).toBeInstanceOf(ConfigValidationError);
});

test('path prints the resolved config file path', async () => {
  writeFileSync(join(home, 'config.jsonc'), '{ "providers": {} }\n');
  const lines: string[] = [];
  configPathCommand((l) => lines.push(l));
  expect(lines.join('\n')).toContain(home);
});

test('edit bootstraps the config dir and a default config on a fresh install', async () => {
  // Point at a nested dir that does not exist yet — the fresh-install case where
  // ~/.aio-proxy has never been created. Without bootstrapping, the editor would
  // have no directory to save into.
  const freshHome = join(home, 'nested', 'aio-proxy-home');
  process.env.AIO_PROXY_HOME = freshHome;
  const prevEditor = process.env.EDITOR;
  const prevVisual = process.env.VISUAL;
  // `true` exits 0 immediately, so no interactive editor blocks the test.
  process.env.EDITOR = 'true';
  delete process.env.VISUAL;
  try {
    const target = join(freshHome, 'config.jsonc');
    expect(existsSync(target)).toBe(false);
    configEdit();
    expect(existsSync(target)).toBe(true);
    // The seeded file must be a parseable default config, not an empty stub.
    const seeded = JSON.parse(readFileSync(target, 'utf8')) as { providers?: unknown };
    expect(seeded.providers).toBeDefined();
  } finally {
    if (prevEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = prevEditor;
    if (prevVisual !== undefined) process.env.VISUAL = prevVisual;
  }
});
