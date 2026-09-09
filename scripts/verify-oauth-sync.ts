#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { PluginDescriptor, OAuthAdapter } from '@aio-proxy/plugin-sdk';

import { openDb } from '../packages/core/src/db';
import { createPluginRegistryHost } from '../packages/core/src/plugins/registry';
import { createPluginRepository } from '../packages/core/src/plugins/repository';
import { evaluateOAuthEvidence, type OAuthSyncEvidence } from '../packages/core/src/sync/oauth/adapter-conformance';

type PluginSpec = {
  readonly directory: string;
  readonly entry: string;
};

const pluginSpecs: Readonly<Record<string, PluginSpec>> = {
  '@aio-proxy/plugin-claude-code': { directory: 'claude-code', entry: 'claude-code/src/index.ts' },
  '@aio-proxy/plugin-cursor': { directory: 'cursor', entry: 'cursor/src/index.ts' },
  '@aio-proxy/plugin-google-antigravity': {
    directory: 'google-antigravity',
    entry: 'google-antigravity/src/index.ts',
  },
  '@aio-proxy/plugin-kimi-code': { directory: 'kimi-code', entry: 'kimi-code/src/index.ts' },
  '@aio-proxy/plugin-openai-chatgpt': { directory: 'openai-chatgpt', entry: 'openai-chatgpt/src/index.ts' },
  '@aio-proxy/plugin-xai-grok': { directory: 'xai-grok', entry: 'xai-grok/src/index.ts' },
  '@aio-proxy/plugin-github-copilot': { directory: 'github-copilot', entry: 'github-copilot/src/index.ts' },
  '@aio-proxy/plugin-openrouter': { directory: 'openrouter', entry: 'openrouter/src/index.ts' },
  '@aio-proxy/plugin-muse-code': { directory: 'muse-code', entry: 'muse-code/src/index.ts' },
};

const evidencePath = resolve(
  process.env['OAUTH_SYNC_EVIDENCE_PATH'] ??
    join(import.meta.dir, '..', 'docs', 'testing', 'evidence', 'oauth-sync.json'),
);

const requestedPlugin = argumentValue('--plugin');
if (requestedPlugin === undefined) {
  throw new Error('Usage: bun scripts/verify-oauth-sync.ts --plugin <package> --live');
}
if (!process.argv.includes('--live')) {
  throw new Error('Use --live with a dedicated OAuth sync test account');
}

const spec = pluginSpecs[requestedPlugin];
if (spec === undefined) throw new Error(`Unsupported built-in OAuth plugin: ${requestedPlugin}`);

const packageJson = (await Bun.file(
  join(import.meta.dir, '..', 'packages', 'plugins', spec.directory, 'package.json'),
).json()) as {
  readonly version: string;
};
const descriptorModule = (await import(new URL(`../packages/plugins/${spec.entry}`, import.meta.url).href)) as {
  readonly default?: PluginDescriptor;
};
const descriptor = descriptorModule.default;
if (descriptor === undefined) throw new Error(`Plugin ${requestedPlugin} does not export a default descriptor`);

const adapter = await resolveAdapter(requestedPlugin, descriptor);
const baseEvidence = {
  plugin: requestedPlugin,
  pluginVersion: packageJson.version,
  capability: adapter.id,
  formatVersion: adapter.credentialSync?.formatVersion ?? 0,
  testedAt: new Date().toISOString(),
  upstream: process.env['OAUTH_SYNC_UPSTREAM'] ?? 'unconfigured',
} as const;

let evidence: OAuthSyncEvidence = {
  ...baseEvidence,
  copiedUse: 'blocked',
  rotation: adapter.refreshCredential === undefined ? 'not-applicable' : 'blocked',
  uncertainRecovery: 'blocked',
  deviceBinding: 'blocked',
  loginEffects: 'blocked',
  independentDetach: 'blocked',
};
let accountRead = false;
let isolatedConfigurations = 0;
let failureCode: string | undefined;

try {
  requireDedicatedTestAccount();
  const providerId = process.env['OAUTH_SYNC_PROVIDER_ID'];
  if (providerId === undefined || providerId.trim() === '') throw new Error('OAUTH_SYNC_PROVIDER_ID is required');
  if ((process.env['OAUTH_SYNC_REMOTE_OBJECT_ID'] ?? '').trim() === '') {
    throw new Error('OAUTH_SYNC_REMOTE_OBJECT_ID is required');
  }

  const sourceDatabase = openDb({ readonly: true });
  try {
    const sourceAccount = createPluginRepository(sourceDatabase.sqlite).readAccount(providerId);
    if (sourceAccount === null) throw new Error('OAuth sync test account was not found');
    if (sourceAccount.plugin !== requestedPlugin || sourceAccount.capability !== adapter.id) {
      throw new Error('OAuth sync test account does not match the selected adapter');
    }
    adapter.credentials.parse(sourceAccount.credential);
    accountRead = true;

    const homes = [
      mkdtempSync(join(tmpdir(), 'aio-proxy-oauth-sync-a-')),
      mkdtempSync(join(tmpdir(), 'aio-proxy-oauth-sync-b-')),
    ];
    try {
      for (const home of homes) {
        const database = openDb({ home });
        try {
          const repository = createPluginRepository(database.sqlite);
          const operation = repository.stageAccountOperation({
            kind: 'create',
            targetDigest: 'oauth-sync-live-test',
            account: {
              providerId: sourceAccount.providerId,
              plugin: sourceAccount.plugin,
              capability: sourceAccount.capability,
              fingerprint: sourceAccount.fingerprint,
              options: sourceAccount.options,
              secrets: sourceAccount.secrets,
              credential: sourceAccount.credential,
              ...(sourceAccount.label === undefined ? {} : { label: sourceAccount.label }),
              ...(sourceAccount.expiresAt === undefined ? {} : { expiresAt: sourceAccount.expiresAt }),
              catalog: {
                kind: 'missing',
                diagnostic: {
                  code: 'CATALOG_UNAVAILABLE',
                  summary: 'OAuth sync conformance does not copy model catalogs',
                  retryable: false,
                  occurredAt: new Date().toISOString(),
                },
              },
            },
          });
          repository.completeAccountOperation(operation.operationId);
          if (repository.readAccount(providerId) === null) throw new Error('isolated account copy was not readable');
          isolatedConfigurations += 1;
        } finally {
          database.close();
        }
      }
    } finally {
      for (const home of homes) rmSync(home, { recursive: true, force: true });
    }
  } finally {
    sourceDatabase.close();
  }
} catch (error) {
  failureCode = errorCode(error);
}

const evaluation = evaluateOAuthEvidence(evidence);
const output = {
  schemaVersion: 1,
  ...baseEvidence,
  account: {
    dedicatedTestAccount: process.env['OAUTH_SYNC_TEST_ACCOUNT'] === '1',
    providerConfigured: process.env['OAUTH_SYNC_PROVIDER_ID'] !== undefined,
    credentialRead: accountRead,
    isolatedConfigurations,
    remoteObjectConfigured: process.env['OAUTH_SYNC_REMOTE_OBJECT_ID'] !== undefined,
  },
  evidence,
  evaluation,
  productionGate: evaluation.multiDevice ? 'verified' : 'blocked',
  ...(failureCode === undefined ? {} : { failureCode }),
  redaction: { credentials: 'omitted', accountIdentifiers: 'omitted' },
};
await Bun.write(evidencePath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ evidencePath, evaluation, failureCode: failureCode ?? null }));
if (failureCode !== undefined || !evaluation.multiDevice) process.exitCode = 1;

async function resolveAdapter(plugin: string, descriptor: PluginDescriptor): Promise<OAuthAdapter> {
  const host = createPluginRegistryHost();
  const staging = host.stage(plugin);
  await descriptor.setup(staging.api, undefined);
  staging.seal();
  staging.commit();
  const capability = host.registry.oauthCapabilities().find((entry) => entry.plugin === plugin);
  if (capability === undefined) throw new Error(`Plugin ${plugin} did not register an OAuth adapter`);
  return capability.adapter;
}

function requireDedicatedTestAccount(): void {
  if (process.env['OAUTH_SYNC_TEST_ACCOUNT'] !== '1') {
    throw new Error('Set OAUTH_SYNC_TEST_ACCOUNT=1 for a dedicated non-production test account');
  }
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 80);
  return 'live-conformance-failed';
}
