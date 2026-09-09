import { expect, test } from 'bun:test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
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
