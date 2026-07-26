import { afterEach, describe, expect, test } from 'bun:test';

import type { LoopbackRequest } from '@aio-proxy/plugin-sdk';

import { LoopbackRequestInvalidError, runLoopbackAuthorization } from './index';
import { createDeps, request, resetInteractive } from './test-support';

afterEach(resetInteractive);

describe('loopback request validation', () => {
  test.each([
    ['null request', null],
    ['missing request fields', {}],
    ['non-string state', { ...request(), state: null }],
    ['empty state', request({ state: '' })],
    ['missing redirect', { ...request(), redirect: undefined }],
    ['non-string hostname', { ...request(), redirect: { hostname: 42, port: 'dynamic', path: '/auth/callback' } }],
    [
      'non-loopback hostname',
      { ...request(), redirect: { hostname: 'attacker.example', port: 'dynamic', path: '/auth/callback' } },
    ],
    ['invalid port type', { ...request(), redirect: { hostname: 'localhost', port: null, path: '/auth/callback' } }],
    ['invalid port range', { ...request(), redirect: { hostname: 'localhost', port: 0, path: '/auth/callback' } }],
    ['non-string path', { ...request(), redirect: { hostname: 'localhost', port: 'dynamic', path: null } }],
    ['path without slash', { ...request(), redirect: { hostname: 'localhost', port: 'dynamic', path: 'callback' } }],
    [
      'path with query',
      { ...request(), redirect: { hostname: 'localhost', port: 'dynamic', path: '/callback?secret=x' } },
    ],
    [
      'path with fragment',
      { ...request(), redirect: { hostname: 'localhost', port: 'dynamic', path: '/callback#secret' } },
    ],
    ['non-function authorization URL builder', { ...request(), authorizationUrl: 'https://identity.example' }],
    ['non-boolean manual callback flag', { ...request(), allowManualCallbackUrl: 'yes' }],
  ] as const)('rejects invalid loopback request input with a safe typed error: %s', async (_name, value) => {
    const created = createDeps();
    await expect(runLoopbackAuthorization(value as LoopbackRequest, created.deps)).rejects.toBeInstanceOf(
      LoopbackRequestInvalidError,
    );
    expect(created.opened).toEqual([]);
  });
});
