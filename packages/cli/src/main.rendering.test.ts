import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';

import { ProviderAccountAlreadyExistsError } from '@aio-proxy/core';
import { getLocale, setLocale } from '@aio-proxy/i18n';

import { runCli } from '../__tests__/cli-test-helpers';
import { GrokAuthError } from './agent/grok-auth';
import { isKnownCliUserError, toExitCode } from './exit/exit';
import { formatCliError } from './main';
import { LoopbackPortUnavailableError } from './plugin-commands/loopback';
import { ProviderCapabilityNotFoundError } from './plugin-commands/provider-login';
import { createCommandSession, PromptCancelledError } from './ui';

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

test('an unknown error after a prompt stays secret through close and formatCliError', async () => {
  const events: string[] = [];
  let body = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      body += String(chunk);
      callback();
    },
  });
  const session = createCommandSession(
    'aio-proxy · Add plugin',
    { stdinIsTTY: true, stderrIsTTY: true, env: {}, input: process.stdin, output },
    { cancelled: 'Cancelled', error: 'Something went wrong' },
    {
      intro() {},
      outro(value) {
        events.push(`outro:${value ?? ''}`);
      },
      cancel(value) {
        events.push(`cancel:${value ?? ''}`);
      },
      note() {},
      updateSettings() {},
      spinner: () => ({
        start() {},
        clear() {},
        get isCancelled() {
          return false;
        },
      }),
      prompts: {
        text: async () => 'ok',
        password: async () => '',
        confirm: async () => false,
        select: async () => 'us',
        multiselect: async () => [],
        isCancel: () => false,
      },
    },
  );
  await session.prompts.input({ message: 'Name' });
  const error = new Error('unknown plugin secret');
  session.close(error);
  const formatted = formatCliError(error, 'en');
  expect(error.message).toBe('unknown plugin secret');
  expect(body).not.toContain('unknown plugin secret');
  expect(events.join('\n')).not.toContain('unknown plugin secret');
  expect(events.some((event) => event.startsWith('outro:') || event.startsWith('cancel:'))).toBe(false);
  expect(formatted.message).toBe('Unexpected internal error');
  expect(formatted.message).not.toContain('unknown plugin secret');
});

test('PromptCancelledError formats to an empty message and stays exit 2', () => {
  const error = new PromptCancelledError();
  expect(formatCliError(error, 'en').message).toBe('');
  expect(formatCliError(error, 'en').message).not.toBe('Unexpected internal error');
  expect(isKnownCliUserError(error)).toBe(false);
  expect(toExitCode(error)).toBe(2);
});
