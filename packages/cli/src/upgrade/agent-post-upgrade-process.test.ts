import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { invokeAgentPostUpgrade, resolveNewAgentBinary } from './agent-post-upgrade-process';
import type { AgentPostUpgradePayload } from './post-upgrade-agents';

const PROCESS_PAYLOAD = {
  format: 1,
  targets: [
    {
      target: 'opencode',
      managedDir: '/tmp/opencode/plugins/aio-proxy',
      adjacentEntry: '/tmp/opencode/plugins/aio-proxy.js',
    },
  ],
} as const satisfies AgentPostUpgradePayload;

const processRoots: string[] = [];
afterEach(async () => {
  await Promise.all(processRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeBinary(
  behavior: 'success' | 'wrong_version' | 'nonzero' | 'malformed' | 'schema_invalid' | 'timeout',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aio-proxy-post-upgrade-child-'));
  processRoots.push(root);
  const binary = join(root, 'aio-proxy');
  const version = behavior === 'wrong_version' ? '1.9.0' : '2.0.0';
  await writeFile(
    binary,
    `#!/usr/bin/env bun
if (process.argv[2] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
if (process.argv[2] !== "__agent-post-upgrade") process.exit(9);
const input = await Bun.stdin.text();
JSON.parse(input);
if (${JSON.stringify(behavior)} === "timeout") await Bun.sleep(60_000);
if (${JSON.stringify(behavior)} === "nonzero") { console.error("child failed"); process.exit(7); }
if (${JSON.stringify(behavior)} === "malformed") console.log("not json");
else if (${JSON.stringify(behavior)} === "schema_invalid") console.log(JSON.stringify([{ target: "unknown", status: "updated" }]));
else console.log(JSON.stringify([{ target: "opencode", status: "updated" }]));
`,
  );
  await chmod(binary, 0o700);
  return binary;
}

test('verified new binary receives one closed-stdin JSON payload and returns typed JSON', async () => {
  const binary = await fakeBinary('success');
  await expect(resolveNewAgentBinary({ method: 'binary', path: binary }, '2.0.0')).resolves.toBe(binary);
  await expect(invokeAgentPostUpgrade(binary, PROCESS_PAYLOAD, { timeoutMs: 1_000 })).resolves.toEqual([
    { target: 'opencode', status: 'updated' },
  ]);
});

test('wrong installed version fails before the hidden command can run', async () => {
  const binary = await fakeBinary('wrong_version');
  await expect(resolveNewAgentBinary({ method: 'binary', path: binary }, '2.0.0')).rejects.toThrow('expected 2.0.0');
});

test('a package-manager upgrade re-resolves aio-proxy from PATH', async () => {
  const binary = await fakeBinary('success');
  const previous = process.env.PATH;
  process.env.PATH = [dirname(binary), previous].filter((value) => value !== undefined).join(delimiter);
  try {
    await expect(resolveNewAgentBinary({ method: 'bun' }, '2.0.0')).resolves.toBe(binary);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test.each(['nonzero', 'malformed', 'schema_invalid'] as const)(
  '%s child output is a protocol failure',
  async (behavior) => {
    const binary = await fakeBinary(behavior);
    await expect(invokeAgentPostUpgrade(binary, PROCESS_PAYLOAD, { timeoutMs: 1_000 })).rejects.toThrow();
  },
);

test('the hidden child is killed at the configured timeout', async () => {
  const binary = await fakeBinary('timeout');
  await expect(invokeAgentPostUpgrade(binary, PROCESS_PAYLOAD, { timeoutMs: 25 })).rejects.toThrow('timed out');
});
