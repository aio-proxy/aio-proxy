import { expect, test } from 'bun:test';

import { PortOutOfRangeError } from '@aio-proxy/i18n';

import { ReloadError, ServeListenError, StatusNotRunningError } from '../errors';
import { CliExit, EXIT, toExitCode } from './exit';

test('port conflict is unrecoverable (1)', () => {
  expect(toExitCode(new ServeListenError('127.0.0.1', 9317))).toBe(EXIT.unrecoverable);
});

test('out-of-range port is unrecoverable (1)', () => {
  expect(toExitCode(new PortOutOfRangeError('99999'))).toBe(EXIT.unrecoverable);
});

test('unknown error is transient (2)', () => {
  expect(toExitCode(new Error('boom'))).toBe(EXIT.transient);
});

test('CliExit carries its own code', () => {
  expect(toExitCode(new CliExit(EXIT.unrecoverable, 'bad config'))).toBe(1);
});

test('a transient reload failure (transport/5xx) stays retryable (2)', () => {
  // Connection refused / timeout / 5xx: a restart or retry may succeed.
  expect(toExitCode(new ReloadError('connect timeout', true))).toBe(EXIT.transient);
});

test('a terminal reload rejection (e.g. 409 invalid config) is unrecoverable (1)', () => {
  // The daemon answered and rejected the reload; retrying the same bad config is futile.
  expect(toExitCode(new ReloadError('invalid config', false))).toBe(EXIT.unrecoverable);
});

test('an unreachable daemon (status) is transient (2)', () => {
  // `status` must exit nonzero-but-retryable so a health check can detect "down".
  expect(toExitCode(new StatusNotRunningError())).toBe(EXIT.transient);
});
