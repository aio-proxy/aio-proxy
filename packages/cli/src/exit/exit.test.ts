import { expect, test } from 'bun:test';

import { PortOutOfRangeError } from '@aio-proxy/i18n';

import { ServeListenError } from '../errors';
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
