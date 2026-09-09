#!/usr/bin/env bun

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { createPluginRegistryHost } from '../packages/core/src/plugins/registry';
import { evaluateOAuthEvidence, type OAuthSyncEvidence } from '../packages/core/src/sync/oauth/adapter-conformance';
import type { PluginDescriptor } from '../packages/plugin-sdk/src';
import { runOAuthSyncLive, type LiveFailureCode } from './verify-oauth-sync-live';

type PluginSpec = { readonly directory: string; readonly entry: string };
const plugins: Readonly<Record<string, PluginSpec>> = {
  '@aio-proxy/plugin-claude-code': {
    directory: 'claude-code',
    entry: 'claude-code/src/index.ts',
  },
  '@aio-proxy/plugin-cursor': {
    directory: 'cursor',
    entry: 'cursor/src/index.ts',
  },
  '@aio-proxy/plugin-google-antigravity': {
    directory: 'google-antigravity',
    entry: 'google-antigravity/src/index.ts',
  },
  '@aio-proxy/plugin-kimi-code': {
    directory: 'kimi-code',
    entry: 'kimi-code/src/index.ts',
  },
  '@aio-proxy/plugin-openai-chatgpt': {
    directory: 'openai-chatgpt',
    entry: 'openai-chatgpt/src/index.ts',
  },
  '@aio-proxy/plugin-xai-grok': {
    directory: 'xai-grok',
    entry: 'xai-grok/src/index.ts',
  },
  '@aio-proxy/plugin-github-copilot': {
    directory: 'github-copilot',
    entry: 'github-copilot/src/index.ts',
  },
  '@aio-proxy/plugin-openrouter': {
    directory: 'openrouter',
    entry: 'openrouter/src/index.ts',
  },
  '@aio-proxy/plugin-muse-code': {
    directory: 'muse-code',
    entry: 'muse-code/src/index.ts',
  },
};

const evidencePath = resolve(
  process.env['OAUTH_SYNC_EVIDENCE_PATH'] ??
    join(import.meta.dir, '..', 'docs', 'testing', 'evidence', 'oauth-sync.json'),
);

type SetupCode =
  | 'setup-test-home-required'
  | 'setup-production-home'
  | 'setup-dedicated-account-required'
  | 'setup-provider-required'
  | 'setup-remote-object-required'
  | 'setup-remote-object-invalid';
const safeCodes = new Set<string>([
  'setup-test-home-required',
  'setup-production-home',
  'setup-dedicated-account-required',
  'setup-provider-required',
  'setup-remote-object-required',
  'setup-remote-object-invalid',
  'setup-sync-binding-required',
  'setup-backend-required',
  'setup-backend-unavailable',
  'setup-remote-object-missing',
  'setup-remote-object-invalid',
  'assertion-copied-use-failed',
  'assertion-rotation-failed',
  'assertion-recovery-failed',
  'assertion-device-binding-failed',
  'assertion-login-effects-failed',
  'assertion-detach-failed',
]);

function homeInput(): string {
  const raw = process.env['OAUTH_SYNC_TEST_HOME'];
  if (raw === undefined || raw.trim() === '') throw new Error('setup-test-home-required');
  const home = resolve(raw);
  const production = resolve(join(homedir(), '.aio-proxy'));
  if (home === production || home === resolve(process.env['AIO_PROXY_HOME'] ?? production))
    throw new Error('setup-production-home');
  return home;
}

function liveInput(): {
  readonly providerId: string;
  readonly remoteObjectId: string;
} {
  if (process.env['OAUTH_SYNC_TEST_ACCOUNT'] !== '1') throw new Error('setup-dedicated-account-required');
  const providerId = process.env['OAUTH_SYNC_PROVIDER_ID']?.trim();
  if (providerId === undefined || providerId === '') throw new Error('setup-provider-required');
  const remoteObjectId = process.env['OAUTH_SYNC_REMOTE_OBJECT_ID']?.trim();
  if (remoteObjectId === undefined || remoteObjectId === '') throw new Error('setup-remote-object-required');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(remoteObjectId))
    throw new Error('setup-remote-object-invalid');
  return { providerId, remoteObjectId };
}

async function main(): Promise<void> {
  const plugin = argumentValue('--plugin');
  if (plugin === undefined || !process.argv.includes('--live')) throw new Error('usage');
  const spec = plugins[plugin];
  if (spec === undefined) throw new Error('unsupported-plugin');
  const packageJson = (await Bun.file(
    join(import.meta.dir, '..', 'packages', 'plugins', spec.directory, 'package.json'),
  ).json()) as { readonly version: string };
  const imported = (await import(new URL(`../packages/plugins/${spec.entry}`, import.meta.url).href)) as {
    readonly default?: PluginDescriptor;
  };
  const descriptor = imported.default;
  if (descriptor === undefined) throw new Error('oauth-adapter-unavailable');
  const host = createPluginRegistryHost();
  const staging = host.stage(plugin);
  await descriptor.setup(staging.api, undefined);
  staging.seal();
  staging.commit();
  const entry = host.registry.oauthCapabilities().find((item) => item.plugin === plugin);
  if (entry === undefined) throw new Error('oauth-adapter-unavailable');
  const adapter = entry.adapter;
  const base = {
    plugin,
    pluginVersion: packageJson.version,
    capability: adapter.id,
    formatVersion: adapter.credentialSync?.formatVersion ?? 0,
    testedAt: new Date().toISOString(),
    upstream: process.env['OAUTH_SYNC_UPSTREAM'] ?? 'unconfigured',
  } as const;
  let evidence: OAuthSyncEvidence = {
    ...base,
    copiedUse: 'blocked',
    rotation: adapter.refreshCredential === undefined ? 'not-applicable' : 'blocked',
    uncertainRecovery: 'blocked',
    deviceBinding: 'blocked',
    loginEffects: 'blocked',
    independentDetach: 'blocked',
  };
  let failureCode: string | undefined;
  let details = {
    credentialRead: false,
    isolatedConfigurations: 0,
    backendConnected: false,
    remoteObjectObserved: false,
  };
  try {
    const home = homeInput();
    const { providerId, remoteObjectId } = liveInput();
    const result = await runOAuthSyncLive({
      home,
      providerId,
      remoteObjectId,
      plugin,
      pluginVersion: packageJson.version,
      adapter,
    });
    evidence = result.evidence;
    details = result.details;
    failureCode = result.failureCode;
  } catch (error) {
    const code = error instanceof Error ? error.message : 'setup-backend-unavailable';
    failureCode = safeCodes.has(code) ? code : 'setup-backend-unavailable';
  }
  const evaluation = evaluateOAuthEvidence(evidence);
  const output = {
    schemaVersion: 1,
    ...base,
    account: {
      dedicatedTestAccount: process.env['OAUTH_SYNC_TEST_ACCOUNT'] === '1',
      testHomeConfigured: process.env['OAUTH_SYNC_TEST_HOME'] !== undefined,
      providerConfigured: process.env['OAUTH_SYNC_PROVIDER_ID'] !== undefined,
      remoteObjectConfigured: process.env['OAUTH_SYNC_REMOTE_OBJECT_ID'] !== undefined,
      ...details,
    },
    evidence,
    evaluation,
    productionGate: evaluation.multiDevice ? 'verified' : 'blocked',
    ...(failureCode === undefined ? {} : { failureCode }),
    redaction: {
      credentials: 'omitted',
      accountIdentifiers: 'omitted',
      errors: 'allowlisted-codes-only',
    },
  };
  await Bun.write(evidencePath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    JSON.stringify({
      evidencePath,
      evaluation,
      failureCode: failureCode ?? null,
    }),
  );
  if (failureCode !== undefined || !evaluation.multiDevice) process.exitCode = 1;
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (import.meta.main)
  await main().catch(() => {
    process.exitCode = 1;
  });

export type { SetupCode, LiveFailureCode };
