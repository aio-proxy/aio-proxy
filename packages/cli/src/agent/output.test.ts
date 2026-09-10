import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { m } from '@aio-proxy/i18n';

import type { AgentListResult } from './agent';
import { renderAgentConfigure, renderAgentList } from './output';

const OUTPUT_INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
const completeListResult: AgentListResult = {
  targets: [
    {
      target: 'opencode',
      host: {
        target: 'opencode',
        detected: true,
        version: '1.17.10',
        minimumVersion: '1.17.10',
        support: 'supported',
      },
      integration: 'managed',
      marker: {
        format: 1,
        managedBy: 'aio-proxy',
        agent: 'opencode',
        installationId: OUTPUT_INSTALLATION,
        adapterVersion: '1.2.3',
        endpoint: 'http://127.0.0.1:9317',
      },
      entry: 'present',
      catalog: 'fresh',
      lastSuccessfulAt: '2026-08-18T00:05:00.000Z',
      endpointMatches: true,
      authorization: 'active',
      schemaCompatibility: 'compatible',
    },
  ],
  server: 'reachable',
  deviceAuthorization: 'available',
  catalogSchemaVersions: [1],
  authorizations: [
    {
      installationId: OUTPUT_INSTALLATION,
      target: 'opencode',
      adapterVersion: '1.2.3',
      createdAt: '2026-08-18T00:00:00.000Z',
      lastAuthorizedAt: '2026-08-18T00:00:01.000Z',
      authorization: 'active',
      accessExpiresAt: '2026-08-18T00:15:01.000Z',
      local: 'configured',
    },
  ],
  codex: {
    target: 'codex',
    integration: 'static-config',
    configPath: '/tmp/codex/config.toml',
    activeProviderId: 'openai',
    status: 'absent',
    connection: 'not_checked',
    changedPaths: [],
  },
};

const AGENT_KEYS = [
  'cli.agent.description',
  'cli.agent.list.option_check',
  'cli.agent.list.option_authorizations',
  'cli.agent.list.unresolved',
  'cli.agent.list.target',
  'cli.agent.list.server',
  'cli.agent.list.capabilities',
  'cli.agent.list.authorization',
  'cli.agent.configure.host_missing',
  'cli.agent.configure.unsupported',
  'cli.agent.configure.version_unknown',
  'cli.agent.configure.result',
  'cli.agent.configure.server_offline',
  'cli.agent.configure.password_required',
  'cli.agent.configure.login',
  'cli.agent.configure.reload',
  'cli.agent.configure.newer',
  'cli.agent.conflict',
  'cli.agent.remove.server_required',
  'cli.agent.remove.success',
  'cli.agent.revoke.success',
  'cli.agent.upgrade.warning',
  'cli.agent.upgrade.root_effective_user',
  'cli.agent.upgrade.protocol_warning',
  'cli.agent.integration.unresolved',
  'cli.agent.integration.managed',
  'cli.agent.integration.absent',
  'cli.agent.integration.conflict',
  'cli.agent.catalog.fresh',
  'cli.agent.catalog.stale',
  'cli.agent.catalog.missing',
  'cli.agent.authorization.active',
  'cli.agent.authorization.expired',
  'cli.agent.authorization.revoked',
  'cli.agent.authorization.missing',
  'cli.agent.authorization.not_checked',
  'cli.agent.schema.compatible',
  'cli.agent.schema.incompatible',
  'cli.agent.schema.not_checked',
  'cli.agent.endpoint.match',
  'cli.agent.endpoint.mismatch',
  'cli.agent.endpoint.unknown',
  'cli.agent.status.installed',
  'cli.agent.status.updated',
  'cli.agent.status.newer',
  'cli.agent.loopback_required',
  'cli.agent.codex.provider_id',
  'cli.agent.codex.provider_conflict',
  'cli.agent.codex.provider_id_invalid',
  'cli.agent.codex.key_select',
  'cli.agent.codex.sources',
  'cli.agent.codex.sources_required',
  'cli.agent.codex.migrate',
  'cli.agent.codex.list',
  'cli.agent.codex.configured',
  'cli.agent.codex.cancelled',
  'cli.agent.codex.non_interactive',
  'cli.agent.codex.restore',
  'cli.agent.codex.offline',
  'cli.agent.codex.version_unverified',
  'cli.agent.codex.migrate_explanation',
  'cli.agent.codex.migration_complete',
  'cli.agent.codex.migration_partial',
  'cli.agent.codex.migration_blocked',
  'cli.agent.codex.removed',
  'cli.agent.codex.keys_retained',
  'cli.agent.codex.restore_option',
  'cli.agent.codex.pending_recovery',
] as const;

const flattenMessages = (value: unknown, prefix = ''): Record<string, string> => {
  if (typeof value === 'string') return prefix === '' ? {} : { [prefix]: value };
  if (value === null || typeof value !== 'object') return {};
  return Object.entries(value as Record<string, unknown>).reduce((acc, [key, child]) => {
    const next = prefix === '' ? key : `${prefix}.${key}`;
    return { ...acc, ...flattenMessages(child, next) };
  }, {});
};

test('JSON list rendering is exactly one parseable line', () => {
  const lines = renderAgentList(completeListResult, true);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual(completeListResult);
});

test('text list rendering exposes every diagnostic field promised by list --check', () => {
  const text = renderAgentList(completeListResult, false).join('\n');
  for (const value of [
    '1.17.10',
    OUTPUT_INSTALLATION,
    '1.2.3',
    'http://127.0.0.1:9317',
    'match',
    '2026-08-18T00:05:00.000Z',
    'active',
    'compatible',
    'available',
    '1',
  ])
    expect(text).toContain(value);
});

test.each([
  [{ version: '1.17.9', minimumVersion: '1.17.10', support: 'unsupported' }, '1.17.9', '1.17.10'],
  [{ minimumVersion: '1.17.10', support: 'unknown' }, 'opencode', 'version'],
] as const)('configure renders host compatibility warning for %o', (hostFields, first, second) => {
  const lines = renderAgentConfigure({
    target: 'opencode',
    installed: true,
    status: 'installed',
    server: 'reachable',
    host: { target: 'opencode', detected: true, ...hostFields },
    deviceAuthorization: 'available',
    loginCommand: 'opencode auth login --provider aio-proxy',
    reloadRequired: true,
  });
  expect(lines.join('\n')).toContain(first);
  expect(lines.join('\n')).toContain(second);
});

test('Codex configure output reports detected version without claiming a minimum', () => {
  const text = renderAgentConfigure({
    target: 'codex',
    integration: 'static-config',
    status: 'configured',
    providerId: 'custom',
    configPath: '/tmp/codex/config.toml',
    connection: 'ok',
    credential: 'placeholder',
    migration: { status: 'empty' },
    version: '0.146.0',
    versionCompatibility: 'unverified',
  }).join('\n');
  expect(text).toContain('0.146.0');
  expect(text).toContain('unverified');
  expect(text).not.toContain('minimum');
});

test('Codex non-interactive output is localized and does not mention a write', () => {
  const text = renderAgentConfigure({
    target: 'codex',
    integration: 'static-config',
    status: 'cancelled',
    configPath: '/tmp/codex/config.toml',
    connection: 'not_checked',
    credential: 'none',
    migration: { status: 'not_requested' },
    reason: 'non_interactive',
  }).join('\n');
  expect(text).toContain('interactive');
  expect(text).toContain('no files were changed');
});

test('Codex migration restore output does not claim configuration changed', () => {
  const text = renderAgentConfigure({
    target: 'codex',
    integration: 'static-config',
    status: 'unchanged',
    configPath: '/tmp/codex/config.toml',
    connection: 'not_checked',
    credential: 'none',
    migration: { status: 'completed', migrated: 1, skipped: 0, conflicts: 0 },
    migrationAction: 'restore',
  }).join('\n');
  expect(text).toContain('history ownership restored');
  expect(text).not.toContain('configuration unchanged');
  expect(text).not.toContain('Reopen Codex');
});

test('every Agent lifecycle key exists in all five source locales and compiled Paraglide output', () => {
  const messagesDir = join(import.meta.dir, '../../../../packages/i18n/messages');
  const locales = readdirSync(messagesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length));
  expect(locales).toEqual(expect.arrayContaining(['en', 'ja', 'ko', 'zh-Hans', 'zh-Hant']));
  expect(locales).toHaveLength(5);
  for (const locale of locales) {
    const flattened = flattenMessages(JSON.parse(readFileSync(join(messagesDir, `${locale}.json`), 'utf8')));
    for (const key of AGENT_KEYS) {
      expect(flattened[key], `${locale} ${key}`).toEqual(expect.any(String));
      expect(flattened[key]!.length).toBeGreaterThan(0);
    }
  }
  for (const key of AGENT_KEYS) {
    expect(typeof m[key as keyof typeof m], `compiled ${key}`).toBe('function');
  }
});
