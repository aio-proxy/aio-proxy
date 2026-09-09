import { expect, test } from 'bun:test';

import { resolveCodexLocation } from './index';

test('resolves CODEX_HOME and fixed managed paths', () => {
  const location = resolveCodexLocation('/tmp/project', {
    CODEX_HOME: '~/codex-home',
    HOME: '/tmp/user',
  });

  expect(location.home).toBe('/tmp/user/codex-home');
  expect(location.configPath).toBe('/tmp/user/codex-home/config.toml');
  expect(location.managedRoot).toBe('/tmp/user/codex-home/.aio-proxy');
  expect(location.markerPath).toBe('/tmp/user/codex-home/.aio-proxy/codex-config.json');
});

test('uses an explicit absolute home and ignores blank CODEX_HOME', () => {
  const location = resolveCodexLocation('/tmp/project', { CODEX_HOME: '   ', HOME: '/tmp/user' });
  expect(location.home).toBe('/tmp/project');
});
