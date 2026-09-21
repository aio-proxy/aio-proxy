import { describe, expect, test } from 'bun:test';

import { ProviderAccountAlreadyExistsError } from '@aio-proxy/core';
import { getLocale, setLocale } from '@aio-proxy/i18n';

import { runCli } from '../__tests__/cli-test-helpers';
import { GrokAuthError } from './agent/grok-auth';
import { formatCliError } from './main';
import { LoopbackPortUnavailableError } from './plugin-commands/loopback';
import { ProviderCapabilityNotFoundError } from './plugin-commands/provider-login';

describe('cli rendering', () => {
  test('provider subcommands expose unified argument placeholders', () => {
    // Given / When
    const login = runCli(['provider', 'login', '--help']).stdout.toString();
    const probe = runCli(['provider', 'test', '--help']).stdout.toString();

    // Then
    expect(login).toContain('[capability]');
    expect(login).toContain('--provider <id>');
    expect(login).toContain('Re-login an existing OAuth provider by id');
    expect(probe).toContain('<provider-id>');
    expect(probe).not.toContain('<id>');
  });

  test('provider install is no longer a command (installation is plugin add)', () => {
    // Given / When
    const result = runCli(['provider', 'install', 'x']);

    // Then
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("unknown command 'install'");
  });

  test('top-level rendering rejects raw provider-login errors and preserves loopback errors', async () => {
    const originalLocale = getLocale();
    await setLocale('en');
    try {
      const missing = formatCliError(new ProviderCapabilityNotFoundError('missing'), 'en');
      const loopback = formatCliError(new LoopbackPortUnavailableError(1455), 'en');
      const unknown = formatCliError(new Error('unknown plugin secret'), 'en');

      expect(missing.message).toBe('Unexpected internal error');
      expect(loopback.message).toBe('The local callback listener could not use port 1455');
      expect(unknown.message).toBe('Unexpected internal error');
      expect(unknown.message).not.toContain('unknown plugin secret');
    } finally {
      await setLocale(originalLocale);
    }
  });

  test('top-level rendering surfaces typed Grok authorization deadline errors', async () => {
    const originalLocale = getLocale();
    await setLocale('en');
    try {
      const deadline = formatCliError(new GrokAuthError('deadline'), 'en');
      const configuration = formatCliError(new GrokAuthError('configuration'), 'en');
      const temporary = formatCliError(new GrokAuthError('temporary'), 'en');

      expect(deadline.message).toBe('Grok authorization timed out.');
      expect(configuration.message).toBe(
        'Grok authorization cannot continue because the configuration is not current.',
      );
      expect(temporary.message).toBe('Grok authorization failed temporarily. Retry.');
      expect(deadline.message).not.toBe('Unexpected internal error');
    } finally {
      await setLocale(originalLocale);
    }
  });

  test('top-level rendering surfaces Grok configuration-modified fields', async () => {
    const originalLocale = getLocale();
    await setLocale('en');
    try {
      const formatted = formatCliError(new Error('Grok configuration modified: models.default'), 'en');
      const endpoint = formatCliError(new Error('Grok endpoint changed'), 'en');

      expect(formatted.message).toBe('Grok configuration has been modified: models.default.');
      expect(formatted.message).not.toBe('Unexpected internal error');
      expect(endpoint.message).toBe(
        'Grok is already configured for a different proxy endpoint. Remove the integration, then configure it again.',
      );
      expect(endpoint.message).not.toContain('19000');
      expect(endpoint.message).not.toBe('Unexpected internal error');
      const protocol = formatCliError(new Error('grok does not support inbound protocol responses'), 'en');
      expect(protocol.message).toBe('grok does not support inbound protocol responses.');
      expect(protocol.message).not.toBe('Unexpected internal error');
    } finally {
      await setLocale(originalLocale);
    }
  });

  test('top-level rendering rejects forged mutable core provider errors', () => {
    const forged = new ProviderAccountAlreadyExistsError('existing');
    Object.defineProperties(forged, {
      existingProviderId: { value: '\u001b]8;;https://attacker.invalid\u0007stolen', configurable: true },
      suggestedCommand: { value: 'secret extension command', configurable: true },
    });
    forged.message = 'secret extension message';

    const formatted = formatCliError(forged, 'en');

    expect(formatted.message).toBe('Unexpected internal error');
    expect(formatted.message).not.toContain('secret');
    expect(formatted.message).not.toContain('attacker.invalid');
  });

  test('dashboard command help advertises host and port options', () => {
    const help = runCli(['dashboard', '--help']).stdout.toString();
    expect(help).toContain('--host');
    expect(help).toContain('--port');
    expect(help).not.toContain('not yet implemented');
  });
});
