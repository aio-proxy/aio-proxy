import { expect, mock, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import type { AgentTarget } from '@aio-proxy/types';

import type { AgentLocation } from '../agent/hosts';
import {
  AgentPostUpgradePayloadSchema,
  runAgentPostUpgrade,
  type AgentPostUpgradeDeps,
  type AgentPostUpgradePayload,
} from './post-upgrade-agents';

const POST_UPGRADE_INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
const postUpgradeLocation = (target: AgentTarget): AgentLocation => {
  const hostRoot = `/tmp/${target}/${target === 'opencode' ? 'plugins' : 'extensions'}`;
  return {
    target,
    hostRoot,
    managedDir: `${hostRoot}/aio-proxy`,
    ...(target === 'opencode' ? { adjacentEntry: `${hostRoot}/aio-proxy.js` } : {}),
  };
};

const postUpgradeFixture = (
  options: {
    readonly targets?: readonly AgentTarget[];
    readonly managed?: readonly AgentTarget[];
    readonly failure?: 'path mismatch' | 'marker conflict' | 'entry conflict';
  } = {},
) => {
  const targets = options.targets ?? ['opencode'];
  const managed = new Set(options.managed ?? targets);
  const payload: AgentPostUpgradePayload = {
    format: 1,
    targets: targets.map((target) => {
      const location = postUpgradeLocation(target);
      return {
        target,
        managedDir: location.managedDir,
        ...(location.adjacentEntry === undefined ? {} : { adjacentEntry: location.adjacentEntry }),
      };
    }),
  };
  const install = mock(async () => 'updated' as const);
  const deps: AgentPostUpgradeDeps = {
    resolveLocation: async (target) =>
      options.failure === 'path mismatch'
        ? { ...postUpgradeLocation(target), managedDir: `/tmp/different/${target}` }
        : postUpgradeLocation(target),
    inspect: async (location) => {
      if (options.failure === 'marker conflict' || options.failure === 'entry conflict') {
        return {
          integration: 'conflict',
          catalog: 'missing',
          reason: options.failure === 'entry conflict' ? 'entry_invalid' : 'marker_invalid',
        };
      }
      if (!managed.has(location.target)) return { integration: 'absent', catalog: 'missing' };
      return {
        integration: 'managed',
        catalog: 'fresh',
        marker: {
          format: 1,
          managedBy: 'aio-proxy',
          agent: location.target,
          installationId: POST_UPGRADE_INSTALLATION,
          adapterVersion: '1.0.0',
          endpoint: 'http://127.0.0.1:9317',
        },
      };
    },
    install,
    readAssets: async () => new Map([['index.js', new TextEncoder().encode('adapter')]]),
    adapterVersion: '2.0.0',
    now: () => 1_000,
  };
  return { payload, deps, install };
};

test('post-upgrade updates only passed, re-resolved, already-managed targets', async () => {
  const f = postUpgradeFixture({ targets: ['opencode', 'pi'], managed: ['opencode'] });
  const result = await runAgentPostUpgrade(f.payload, f.deps);
  expect(result).toEqual([
    { target: 'opencode', status: 'updated' },
    { target: 'pi', status: 'absent' },
  ]);
  expect(f.install).toHaveBeenCalledTimes(1);
  expect(f.install.mock.calls[0]![0].adapterVersion).toBe('2.0.0');
});

test.each(['path mismatch', 'marker conflict', 'entry conflict'] as const)(
  '%s warns and writes nothing',
  async (failure) => {
    const f = postUpgradeFixture({ failure });
    await expect(runAgentPostUpgrade(f.payload, f.deps)).resolves.toEqual([
      expect.objectContaining({ status: 'warning' }),
    ]);
    expect(f.install).not.toHaveBeenCalled();
  },
);

test('post-upgrade never creates an absent integration', async () => {
  const f = postUpgradeFixture({ managed: [] });
  await runAgentPostUpgrade(f.payload, f.deps);
  expect(f.install).not.toHaveBeenCalled();
});

const validOpenCode = {
  target: 'opencode' as const,
  managedDir: '/tmp/opencode/plugins/aio-proxy',
  adjacentEntry: '/tmp/opencode/plugins/aio-proxy.js',
};

test.each([
  ['unknown payload field', { format: 1, targets: [validOpenCode], extra: true }],
  ['unknown target field', { format: 1, targets: [{ ...validOpenCode, extra: true }] }],
  ['duplicate target', { format: 1, targets: [validOpenCode, { ...validOpenCode }] }],
  ['relative managedDir', { format: 1, targets: [{ ...validOpenCode, managedDir: 'plugins/aio-proxy' }] }],
  ['relative adjacentEntry', { format: 1, targets: [{ ...validOpenCode, adjacentEntry: 'aio-proxy.js' }] }],
  [
    'OpenCode without adjacentEntry',
    { format: 1, targets: [{ target: 'opencode', managedDir: '/tmp/opencode/plugins/aio-proxy' }] },
  ],
  [
    'non-OpenCode with adjacentEntry',
    {
      format: 1,
      targets: [
        { target: 'pi', managedDir: '/tmp/pi/extensions/aio-proxy', adjacentEntry: '/tmp/pi/extensions/aio-proxy.js' },
      ],
    },
  ],
  [
    'more than three rows',
    {
      format: 1,
      targets: [
        validOpenCode,
        { target: 'pi', managedDir: '/tmp/pi/extensions/aio-proxy' },
        { target: 'omp', managedDir: '/tmp/omp/extensions/aio-proxy' },
        {
          target: 'opencode',
          managedDir: '/tmp/other/plugins/aio-proxy',
          adjacentEntry: '/tmp/other/plugins/aio-proxy.js',
        },
      ],
    },
  ],
] as const)('payload schema rejects %s', (_name, payload) => {
  expect(AgentPostUpgradePayloadSchema.safeParse(payload).success).toBe(false);
});

test('oversized stdin is rejected before the hidden action allocates the body', async () => {
  const modulePath = fileURLToPath(new URL('./post-upgrade-agents.ts', import.meta.url));
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `const { readAgentPostUpgradePayload } = await import(${JSON.stringify(modulePath)});
await readAgentPostUpgradePayload();`,
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    child.stdin.write(Buffer.alloc(64 * 1_024 + 1, 0x61));
    child.stdin.end();
  } catch (error) {
    try {
      child.kill('SIGKILL');
    } catch {}
    throw error;
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stdout).toBe('');
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain('exceeds 64 KiB');
});
