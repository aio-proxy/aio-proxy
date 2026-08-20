import { describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';

import { cliRunArgs, freePort, output, repoCwd, runCli, waitForOk } from '../__tests__/cli-test-helpers';
import packageJson from '../package.json' with { type: 'json' };
import type { AgentConfigureResult, AgentListResult, AgentRemoveResult, AgentRevokeResult } from './agent';
import type { AgentCliActions } from './agent/output';
import { registerAgentCommands } from './agent/output';
import { buildProgram } from './main';

describe('cli', () => {
  test('prints package version when requested', () => {
    // Given / When
    const result = runCli(['--version']);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(packageJson.version);
  }, 60_000);

  test('localizes help when --lang overrides environment', () => {
    // Given / When
    const english = runCli(['--help'], { LANG: 'en_US.UTF-8' });
    const chinese = runCli(['--lang', 'zh-CN', '--help'], {
      LANG: 'en_US.UTF-8',
    });

    // Then
    expect(english.exitCode).toBe(0);
    expect(chinese.exitCode).toBe(0);
    expect(english.stdout.toString()).toContain('AIO Proxy command line');
    expect(chinese.stdout.toString()).toContain('AIO Proxy 命令行界面');
  }, 60_000);

  test('rejects out-of-range run ports', () => {
    // Given / When
    const result = runCli(['--port', '99999']);

    // Then
    expect(result.exitCode).toBe(1);
    expect(output(result)).toContain('Port 99999 is out of range');
  }, 60_000);

  test('reports run port conflicts with the bound address', () => {
    // Given
    const blocker = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {} },
    });

    try {
      // When
      const result = runCli(['run', '--port', String(blocker.port)]);

      // Then
      expect(result.exitCode).toBe(1);
      expect(output(result)).toContain(`127.0.0.1:${blocker.port}`);
      expect(output(result)).not.toContain('Unexpected internal error');
    } finally {
      blocker.stop(true);
    }
  }, 60_000);

  test('exits unrecoverable (1) when startup config is schema-invalid', () => {
    // A schema-invalid config can never succeed on retry; the daemon must exit 1
    // (unrecoverable) so a service manager does not restart it in a loop.
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-badcfg-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.jsonc'), '{ "server": { "port": "not-a-number" }, "providers": {} }\n');
      const result = runCli(['run', '--port', String(freePort())], { AIO_PROXY_HOME: dir });
      expect(result.exitCode).toBe(1);
      expect(output(result)).not.toContain('Unexpected internal error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('bootstraps missing non-tty config path and serves health', async () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-cli-'));
    const home = join(dir, 'nested');
    const configFile = join(home, 'config.jsonc');
    const port = freePort();
    const server = Bun.spawn(cliRunArgs(port), {
      cwd: repoCwd,
      env: { ...process.env, AIO_PROXY_HOME: home },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const stdout = new Response(server.stdout).text();

    try {
      // When
      const response = await waitForOk(`http://127.0.0.1:${port}/health`, {
        probeTimeoutMs: 1_000,
        readinessTimeoutMs: 20_000,
      });

      // Then
      expect(response.status).toBe(200);
      expect(existsSync(configFile)).toBe(true);
      expect(await readFile(configFile, 'utf8')).toContain('providers');
      server.kill();
      await server.exited;
      const outputText = await stdout;
      expect(outputText).toContain(`http://127.0.0.1:${port}/dashboard`);
      if (port !== 9_317) {
        expect(outputText).not.toContain('http://127.0.0.1:9317/dashboard');
      }
    } finally {
      server.kill();
      await server.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('bare run honors the configured server.port when no flag is given', async () => {
    // A managed service starts `run` with no flags; it must bind the config's
    // server.port instead of the hardcoded default, or the configured port is
    // silently ignored.
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-cfgport-'));
    const port = freePort();
    writeFileSync(join(dir, 'config.jsonc'), `{ "server": { "port": ${port} }, "providers": {} }\n`);
    const server = Bun.spawn([process.execPath, 'run', 'packages/cli/src/main.ts', 'run'], {
      cwd: repoCwd,
      env: { ...process.env, AIO_PROXY_HOME: dir, LANG: 'en_US.UTF-8' },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const stderr = new Response(server.stderr).text();
    try {
      const response = await waitForOk(`http://127.0.0.1:${port}/health`, {
        probeTimeoutMs: 1_000,
        readinessTimeoutMs: 20_000,
      });
      expect(response.status).toBe(200);
      server.kill();
      await server.exited;
      expect(await stderr).toContain(`127.0.0.1:${port}`);
    } finally {
      server.kill();
      await server.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('exits unrecoverable (1) when service.env exists but cannot be read', () => {
    // A service.env that cannot be read (here, a directory in its place) can never
    // succeed on retry; the daemon must exit 1 so a service manager does not restart
    // it in a loop, matching the malformed-config contract.
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-badenv-'));
    try {
      writeFileSync(join(dir, 'config.jsonc'), '{ "providers": {} }\n');
      mkdirSync(join(dir, 'service.env'));
      const result = runCli(['run', '--port', String(freePort())], { AIO_PROXY_HOME: dir });
      expect(result.exitCode).toBe(1);
      expect(output(result)).not.toContain('Unexpected internal error');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
  test('run --help advertises --open and drops --config and --dashboard', () => {
    // Given / When
    const result = runCli(['run', '--help']);

    // Then
    expect(result.exitCode).toBe(0);
    const help = result.stdout.toString();
    expect(help).toContain('--open');
    expect(help).not.toContain('config');
    expect(help).not.toContain('--dashboard');
  }, 60_000);

  test('the hidden post-upgrade command is registered and omitted from help', () => {
    const program = buildProgram();
    const child = program.commands.find((command) => command.name() === '__agent-post-upgrade');
    expect(child).toBeDefined();
    expect(program.helpInformation()).not.toContain('__agent-post-upgrade');
  });
});

const listResult: AgentListResult = {
  targets: [
    {
      target: 'opencode',
      host: {
        target: 'opencode',
        detected: true,
        support: 'supported',
        version: '1.17.10',
        minimumVersion: '1.17.10',
      },
      integration: 'absent',
      catalog: 'missing',
      authorization: 'not_checked',
      schemaCompatibility: 'not_checked',
    },
  ],
  server: 'not_checked',
};
const configureResult: AgentConfigureResult = {
  target: 'opencode',
  installed: true,
  status: 'installed',
  server: 'unreachable',
  host: {
    target: 'opencode',
    detected: true,
    support: 'supported',
    version: '1.17.10',
    minimumVersion: '1.17.10',
  },
  loginCommand: 'opencode auth login --provider aio-proxy',
  reloadRequired: true,
};
const removeResult: AgentRemoveResult = {
  target: 'opencode',
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  revokeStatus: 'revoked',
};
const revokeResult: AgentRevokeResult = {
  installationId: removeResult.installationId,
  status: 'revoked',
};

function agentProgram() {
  const lines: string[] = [];
  const actions: AgentCliActions = {
    list: mock(async () => listResult),
    configure: mock(async () => configureResult),
    remove: mock(async () => removeResult),
    revoke: mock(async () => revokeResult),
  };
  const program = new Command().name('aio-proxy').exitOverride();
  registerAgentCommands(program, { actions, print: (line) => lines.push(line) });
  return { actions, lines, program };
}

test.each([
  [['agent', 'list'], 'list'],
  [['agent', 'configure', 'opencode'], 'configure'],
  [['agent', 'remove', 'opencode'], 'remove'],
  [['agent', 'revoke', removeResult.installationId], 'revoke'],
] as const)('%s awaits its action and prints text', async (args, action) => {
  const f = agentProgram();
  await f.program.parseAsync(['node', 'aio-proxy', ...args]);
  expect(f.actions[action]).toHaveBeenCalledTimes(1);
  expect(f.lines.length).toBeGreaterThan(0);
});

test('agent list --json forwards json in options and prints one JSON result', async () => {
  const f = agentProgram();
  await f.program.parseAsync(['node', 'aio-proxy', 'agent', 'list', '--check', '--json']);
  expect(f.actions.list).toHaveBeenCalledWith({ check: true, authorizations: false, json: true });
  expect(f.lines).toHaveLength(1);
  expect(JSON.parse(f.lines[0]!)).toEqual(listResult);
});

test('the real buildProgram registers public Agent commands and keeps the child action hidden', () => {
  const program = buildProgram();
  const agent = program.commands.find((command) => command.name() === 'agent');
  const child = program.commands.find((command) => command.name() === '__agent-post-upgrade');
  expect(agent?.commands.map((command) => command.name())).toEqual(['list', 'configure', 'remove', 'revoke']);
  expect(child).toBeDefined();
  const help = program.helpInformation();
  expect(help).toContain('agent');
  expect(help).not.toContain('__agent-post-upgrade');
});

test('agent configure and remove help render the supported target grammar', () => {
  const program = buildProgram();
  const agent = program.commands.find((command) => command.name() === 'agent');
  const help = agent?.helpInformation() ?? '';
  expect(help).toContain('configure <opencode|pi|omp>');
  expect(help).toContain('remove <opencode|pi|omp>');
  expect(help).not.toContain('<target>');
});
