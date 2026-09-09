import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, 'verify-oauth-sync.ts');

async function run(env: Record<string, string>): Promise<{
  readonly exitCode: number;
  readonly output: string;
  readonly artifact: Record<string, unknown>;
}> {
  const artifactPath = join(mkdtempSync(join(tmpdir(), 'aio-proxy-oauth-runner-test-')), 'evidence.json');
  const child = Bun.spawn([process.execPath, script, '--plugin', '@aio-proxy/plugin-openrouter', '--live'], {
    env: { ...process.env, ...env, OAUTH_SYNC_EVIDENCE_PATH: artifactPath },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
  unlinkSync(artifactPath);
  rmSync(join(artifactPath, '..'), { recursive: true, force: true });
  return { exitCode, output, artifact };
}

test('blocks without an explicit isolated test home even when the account flag is set', async () => {
  const result = await run({
    OAUTH_SYNC_TEST_ACCOUNT: '1',
    OAUTH_SYNC_PROVIDER_ID: 'provider',
    OAUTH_SYNC_REMOTE_OBJECT_ID: '00000000-0000-4000-8000-000000000001',
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('"failureCode":"setup-test-home-required"');
  expect(result.artifact['failureCode']).toBe('setup-test-home-required');
  expect(result.artifact['productionGate']).toBe('blocked');
});

test('rejects the production home before reading credentials', async () => {
  const result = await run({
    OAUTH_SYNC_TEST_HOME: join(homedir(), '.aio-proxy'),
    OAUTH_SYNC_TEST_ACCOUNT: '1',
    OAUTH_SYNC_PROVIDER_ID: 'provider',
    OAUTH_SYNC_REMOTE_OBJECT_ID: '00000000-0000-4000-8000-000000000001',
  });
  expect(result.exitCode).toBe(1);
  expect(result.artifact['failureCode']).toBe('setup-production-home');
  expect(result.artifact['account']).toMatchObject({
    credentialRead: false,
    isolatedConfigurations: 0,
  });
  expect(JSON.stringify(result.artifact)).not.toContain('production database');
});
