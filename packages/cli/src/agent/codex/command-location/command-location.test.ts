import { expect, test } from 'bun:test';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCodexAuthCommand } from './command-location';

async function executableRoot(): Promise<string> {
  const root = join(tmpdir(), `aio-command-location-${crypto.randomUUID()}`);
  await mkdir(join(root, 'stable path'), { recursive: true });
  return root;
}

test('accepts installed aiop and aio-proxy aliases, including spaces in the path', async () => {
  const root = await executableRoot();
  const path = join(root, 'stable path', 'aiop');
  await writeFile(path, '#!/bin/sh\nprintf "aiop 0.21.0\\n"\n');
  await chmod(path, 0o755);
  await expect(resolveCodexAuthCommand({ pathEnv: join(root, 'stable path'), candidates: [path] })).resolves.toBe(path);
});

test('rejects missing, development and unknown command entries', async () => {
  await expect(resolveCodexAuthCommand({ pathEnv: '', candidates: ['/missing/aiop'] })).rejects.toThrow();
  await expect(
    resolveCodexAuthCommand({ pathEnv: '', candidates: ['/usr/bin/bun', '/tmp/project/node_modules/.bin/aiop'] }),
  ).rejects.toThrow();
  await expect(resolveCodexAuthCommand({ pathEnv: '', candidates: ['/tmp/other-tool'] })).rejects.toThrow();
});

test('accepts the published npm launcher while rejecting arbitrary javascript entries', async () => {
  const root = await executableRoot();
  const packageRoot = join(root, 'node_modules', 'aio-proxy');
  const launcher = join(packageRoot, 'bin', 'aio-proxy.js');
  await mkdir(join(packageRoot, 'bin'), { recursive: true });
  await writeFile(launcher, '#!/usr/bin/env node\nconsole.log("aio-proxy 0.21.0")\n');
  await chmod(launcher, 0o755);
  await expect(resolveCodexAuthCommand({ candidates: [launcher] })).resolves.toBe(launcher);
  const aiopLauncher = join(packageRoot, 'bin', 'aiop.js');
  await writeFile(aiopLauncher, '#!/usr/bin/env node\nconsole.log("aiop 0.21.0")\n');
  await chmod(aiopLauncher, 0o755);
  const alias = join(root, 'stable path', 'aiop');
  await symlink(aiopLauncher, alias);
  await expect(resolveCodexAuthCommand({ candidates: [alias] })).resolves.toBe(alias);
  const source = join(root, 'src', 'aio-proxy.js');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(source, '#!/usr/bin/env node\nconsole.log("aio-proxy 0.21.0")\n');
  await chmod(source, 0o755);
  await expect(resolveCodexAuthCommand({ candidates: [source] })).rejects.toThrow();
});

test('bounds launchers that keep descendants attached to stdout', async () => {
  const root = await executableRoot();
  const path = join(root, 'stable path', 'aiop');
  await writeFile(path, '#!/bin/sh\nsleep 10 & wait\n');
  await chmod(path, 0o755);
  const startedAt = Date.now();
  await expect(resolveCodexAuthCommand({ candidates: [path] })).rejects.toThrow();
  expect(Date.now() - startedAt).toBeLessThan(3_500);
});
