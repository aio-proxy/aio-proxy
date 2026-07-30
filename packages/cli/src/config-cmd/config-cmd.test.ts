import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configPathCommand, configShow, configValidate } from './config-cmd';

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
  expect(caught).toBeInstanceOf(Error);
});

test('path prints the resolved config file path', async () => {
  writeFileSync(join(home, 'config.jsonc'), '{ "providers": {} }\n');
  const lines: string[] = [];
  configPathCommand((l) => lines.push(l));
  expect(lines.join('\n')).toContain(home);
});
