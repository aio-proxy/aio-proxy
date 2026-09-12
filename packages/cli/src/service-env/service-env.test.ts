import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadServiceEnv, readServiceEnvironment, serviceEnvFile } from './service-env';

const withEnvFile = (contents: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-svc-env-'));
  const configPath = join(dir, 'config.jsonc');
  writeFileSync(serviceEnvFile(configPath), contents);
  return configPath;
};

test('loads KEY=value pairs as literal data without shell expansion', () => {
  // A shell would expand $def / execute the backticks; parsing as data must not.
  const configPath = withEnvFile('API_TOKEN=abc$def\nQUOTED="x y"\nCMD=`echo hi`\n');
  const env: Record<string, string | undefined> = {};
  loadServiceEnv(configPath, env);
  expect(env['API_TOKEN']).toBe('abc$def');
  expect(env['QUOTED']).toBe('x y');
  expect(env['CMD']).toBe('echo hi');
});

test('does not overwrite an existing environment variable', () => {
  const configPath = withEnvFile('OPENAI_API_KEY=from-file\n');
  const env: Record<string, string | undefined> = { OPENAI_API_KEY: 'from-real-env' };
  loadServiceEnv(configPath, env);
  expect(env['OPENAI_API_KEY']).toBe('from-real-env');
});

test('an isolated read observes a later service.env rotation', () => {
  const configPath = withEnvFile('API_TOKEN=old\n');
  expect(readServiceEnvironment(configPath, {})['API_TOKEN']).toBe('old');
  writeFileSync(serviceEnvFile(configPath), 'API_TOKEN=rotated\n');
  expect(readServiceEnvironment(configPath, {})['API_TOKEN']).toBe('rotated');
});

test('an isolated read preserves existing environment values', () => {
  const configPath = withEnvFile('API_TOKEN=from-file\n');
  const base = { API_TOKEN: 'from-real-env' };
  expect(readServiceEnvironment(configPath, base)['API_TOKEN']).toBe('from-real-env');
  expect(base['API_TOKEN']).toBe('from-real-env');
});

test('is a no-op when the env file is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-svc-env-'));
  const env: Record<string, string | undefined> = {};
  loadServiceEnv(join(dir, 'config.jsonc'), env);
  expect(Object.keys(env)).toHaveLength(0);
});
