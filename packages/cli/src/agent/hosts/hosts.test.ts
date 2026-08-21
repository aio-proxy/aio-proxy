import { expect, test } from 'bun:test';

import { detectAgentHost, resolveAgentLocation, type AgentHostDeps } from './hosts';

const hostFixture = (
  options: {
    readonly versionOutput?: string;
    readonly capture?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly home?: string;
    readonly detected?: boolean;
  } = {},
): AgentHostDeps => ({
  which: (name) => (options.detected === false ? null : `/usr/local/bin/${name}`),
  capture: async (command) =>
    command.includes('--version') ? (options.versionOutput ?? '1.17.10') : (options.capture ?? ''),
  env: options.env ?? {},
  home: options.home ?? '/tmp/home',
});

test.each([
  ['opencode', '1.17.10', 'supported', '1.17.10'],
  ['opencode', '1.17.9', 'unsupported', '1.17.10'],
  ['pi', '0.84.2', 'supported', '0.84.2'],
  ['pi', '0.83.0', 'unsupported', '0.84.2'],
  ['omp', 'omp/17.3.7', 'supported', '17.3.7'],
  ['omp', 'omp/17.3.6', 'unsupported', '17.3.7'],
  ['omp', 'nightly', 'unknown', '17.3.7'],
] as const)('%s classifies %s as %s', async (target, output, support, minimumVersion) => {
  const host = await detectAgentHost(target, hostFixture({ versionOutput: output }));
  expect(host).toMatchObject({ detected: true, support, minimumVersion });
});

test('OpenCode parses only the config row from debug paths', async () => {
  const location = await resolveAgentLocation(
    'opencode',
    hostFixture({
      capture: ['home /tmp/home', 'config /tmp/opencode-config', 'state /tmp/state'].join('\n'),
    }),
  );
  expect(location).toEqual({
    target: 'opencode',
    hostRoot: '/tmp/opencode-config/plugins',
    managedDir: '/tmp/opencode-config/plugins/aio-proxy',
    adjacentEntry: '/tmp/opencode-config/plugins/aio-proxy.js',
  });
});

test('official Pi honors only its documented agent-dir override', async () => {
  expect(
    (
      await resolveAgentLocation(
        'pi',
        hostFixture({
          env: { PI_CODING_AGENT_DIR: '/tmp/pi-agent', OMP_PROFILE: 'ignored' },
          home: '/tmp/home',
        }),
      )
    ).managedDir,
  ).toBe('/tmp/pi-agent/extensions/aio-proxy');
});

test.each([
  ['', '/tmp/home/.pi/agent/extensions/aio-proxy'],
  ['~', '/tmp/home/extensions/aio-proxy'],
  ['~/pi-agent', '/tmp/home/pi-agent/extensions/aio-proxy'],
] as const)('official Pi resolves agent-dir override %j like the host', async (override, expected) => {
  expect(
    (
      await resolveAgentLocation(
        'pi',
        hostFixture({
          env: { PI_CODING_AGENT_DIR: override },
          home: '/tmp/home',
        }),
      )
    ).managedDir,
  ).toBe(expected);
});

test('OMP delegates active profile resolution to omp config path', async () => {
  expect((await resolveAgentLocation('omp', hostFixture({ capture: '/tmp/omp-profile/agent\n' }))).managedDir).toBe(
    '/tmp/omp-profile/agent/extensions/aio-proxy',
  );
});
