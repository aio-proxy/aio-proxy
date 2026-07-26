import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { output, runCli, runCliUntilOutput } from './cli-test-helpers';

describe('provider commands', () => {
  test('provider login exposes an optional capability and explicit provider target', () => {
    const result = runCli(['provider', 'login', '--help']);

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain('[capability]');
    expect(stdout).toContain('--provider <id>');
  });

  test('exact built-in package login command enters the account flow', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aio-proxy-cli-login-'));
    try {
      const result = await runCliUntilOutput(
        ['provider', 'login', '@aio-proxy/plugin-google-antigravity'],
        ['Custom Antigravity base URL', 'OAuth capability @aio-proxy/plugin-google-antigravity was not found.'],
        { AIO_PROXY_HOME: home },
      );
      const text = `${result.stdout}${result.stderr}`;

      expect(result.exitCode).not.toBe(0);
      expect(text).toContain('Custom Antigravity base URL');
      expect(text).not.toContain('OAuth capability @aio-proxy/plugin-google-antigravity was not found.');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('provider list prints packages installed in the runtime cache', () => {
    // Given
    const home = mkdtempSync(join(tmpdir(), 'aio-proxy-cli-home-'));
    const packageDir = join(home, 'packages', 'aio-proxy-cli-provider', 'node_modules', 'aio-proxy-cli-provider');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: 'aio-proxy-cli-provider',
        version: '1.0.0',
        main: 'index.js',
      }),
    );
    writeFileSync(join(packageDir, 'index.js'), 'export const ok = true;\n');

    try {
      // When
      const result = runCli(['provider', 'list', '--installed'], { AIO_PROXY_HOME: home });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('aio-proxy-cli-provider 1.0.0');
      expect(result.stdout.toString()).toContain(packageDir);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('provider install reports a failed explicit install', () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-cli-home-'));

    try {
      // When
      const result = runCli(
        ['provider', 'install', 'aio-proxy-missing-package', '--yes', '--registry', 'http://127.0.0.1:9'],
        { AIO_PROXY_HOME: dir },
      );

      // Then
      expect(result.exitCode).toBe(1);
      expect(output(result)).toContain('aio-proxy-missing-package');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('provider install requires explicit confirmation before installing', () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-cli-home-'));

    try {
      // When
      const result = runCli(['provider', 'install', 'aio-proxy-missing-package', '--registry', 'http://127.0.0.1:9'], {
        AIO_PROXY_HOME: dir,
      });

      // Then
      expect(result.exitCode).toBe(1);
      expect(output(result)).toContain('requires --yes');
      expect(existsSync(join(dir, 'packages'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
