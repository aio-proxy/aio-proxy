import { m } from '@aio-proxy/i18n';
import type { Command } from 'commander';
import { z } from 'zod';

import { type Block, createStyle, type Field, formatBlocks, formatTable, plainStyle, type Style } from '../ui';
import type {
  AgentConfigureResult,
  AgentListResult,
  AgentListTargetResult,
  AgentRemoveResult,
  AgentRevokeResult,
} from './agent';
import type { ClaudeCodeConfigureResult, ClaudeCodeListResult, ClaudeCodeRemoveResult } from './claude-code';
import type { CodexConfigureOptions, CodexConfigureResult, CodexListResult, CodexRemoveResult } from './codex';

const renderCodexConfigure = (result: CodexConfigureResult, style: Style): string[] => {
  if (result.status === 'cancelled')
    return [
      `${style.mark('off')} ${
        result.reason === 'non_interactive'
          ? m['cli.agent.codex.non_interactive']()
          : result.reason === 'authorization_incomplete'
            ? m['cli.agent.codex.authorization_incomplete']()
            : m['cli.agent.codex.cancelled']()
      }`,
    ];
  const restoreIncomplete =
    result.migrationAction === 'restore' &&
    (result.migration.status === 'blocked' || result.migration.status === 'partial');
  const lines = [
    `${style.mark(restoreIncomplete ? 'warn' : 'ok')} ${
      result.migrationAction === 'restore'
        ? result.migration.status === 'blocked'
          ? m['cli.agent.codex.migration_blocked']()
          : result.migration.status === 'partial'
            ? m['cli.agent.codex.migration_partial']()
            : m['cli.agent.codex.restore']()
        : m['cli.agent.codex.configured']({
            status: result.status,
            providerId: result.providerId ?? '-',
            configPath: result.configPath,
          })
    }`,
  ];
  if (result.version !== undefined && result.versionCompatibility === 'unverified')
    lines.push(m['cli.agent.codex.version_unverified']({ version: result.version }));
  if (result.authMode !== undefined)
    lines.push(
      m['cli.agent.codex.auth_result']({
        mode: result.authMode,
      }),
    );
  if (result.connection === 'offline' || result.connection === 'invalid_response')
    lines.push(m['cli.agent.codex.offline']());
  if (result.migrationAction !== 'restore') {
    lines.push(m['cli.agent.codex.reopen']());
    if (result.migration.status === 'partial') lines.push(m['cli.agent.codex.migration_partial']());
    else if (result.migration.status === 'blocked') lines.push(m['cli.agent.codex.migration_blocked']());
    else if (result.migration.status === 'completed') lines.push(m['cli.agent.codex.migration_complete']());
  } else if (result.migration.status === 'completed') {
    lines.push(m['cli.agent.codex.migration_complete']());
  }
  return lines;
};

const renderCodexRemove = (result: CodexRemoveResult, style: Style): string[] => [
  `${style.mark(result.status === 'blocked' ? 'warn' : 'ok')} ${m['cli.agent.codex.removed']({ configPath: result.configPath, status: result.status })}`,
  ...(result.status === 'blocked' ? [m['cli.agent.codex.remove_blocked']()] : []),
  m['cli.agent.codex.keys_retained'](),
];

const renderClaudeCodeConfigure = (result: ClaudeCodeConfigureResult, style: Style): string[] => [
  `${style.mark('ok')} ${m['cli.agent.claude_code.configured']({ status: result.status, configPath: result.configPath })}`,
  result.credential === 'placeholder'
    ? m['cli.agent.claude_code.credential_placeholder']()
    : m['cli.agent.claude_code.credential_existing'](),
  ...(result.connection === 'offline' ? [m['cli.agent.claude_code.offline']()] : []),
  m['cli.agent.claude_code.restart'](),
];

const renderClaudeCodeRemove = (result: ClaudeCodeRemoveResult, style: Style): string[] => [
  `${style.mark(result.status === 'partial' ? 'warn' : 'ok')} ${m['cli.agent.claude_code.removed']({ configPath: result.configPath, status: result.status })}`,
  ...(result.preservedPaths.length === 0
    ? []
    : [m['cli.agent.claude_code.preserved']({ fields: result.preservedPaths.join(', ') })]),
  m['cli.agent.codex.keys_retained'](),
];

const endpointMatch = (matches: boolean | undefined): string =>
  matches === undefined ? 'unknown' : matches ? 'match' : 'mismatch';

const hostField = (host: AgentListTargetResult['host']): Field => [
  m['cli.agent.list.label_host'](),
  m['cli.agent.list.host_value']({
    version: host.version ?? 'unknown',
    minimum: host.minimumVersion,
    support: host.support,
  }),
];

const accessFields = (target: AgentListTargetResult): Field[] => [
  [m['cli.agent.list.label_authorization'](), target.authorization],
  [m['cli.agent.list.label_schema'](), target.schemaCompatibility],
];

function targetMark(style: Style, target: AgentListTargetResult): string {
  if (target.integration === 'absent') return style.mark('off');
  const drifted =
    target.integration === 'unresolved' ||
    target.integration === 'conflict' ||
    target.host.support === 'unsupported' ||
    ('endpointMatches' in target && target.endpointMatches === false) ||
    (target.target === 'grok' && target.configuration !== 'current');
  return style.mark(drifted ? 'warn' : 'ok');
}

function grokNotes(style: Style, target: Extract<AgentListTargetResult, { target: 'grok' }>): string[] {
  if (target.integration === 'absent' || target.integration === 'unresolved') return [];
  const fields = target.fields.join(', ');
  if (target.configuration === 'modified')
    return [`${style.mark('warn')} ${m['cli.agent.configuration_modified']({ fields })}`];
  if (target.configuration === 'missing') return [`${style.mark('warn')} ${m['cli.agent.configuration_missing']()}`];
  if (target.configuration === 'recovery_required')
    return [`${style.mark('warn')} ${m['cli.agent.recovery_required']({ fields })}`];
  return [];
}

function targetBlock(style: Style, target: AgentListTargetResult): Block {
  const mark = targetMark(style, target);
  const title = `${style.strong(target.target)}  ${target.integration}`;
  if (target.target !== 'grok' && target.integration === 'unresolved') {
    return {
      mark,
      title,
      fields: [[m['cli.agent.list.label_reason'](), target.reason], hostField(target.host), ...accessFields(target)],
    };
  }
  const catalog = target.target === 'grok' ? m['cli.agent.host_managed_catalog']() : target.catalog;
  const lastSuccessfulAt = target.target === 'grok' ? '-' : (target.lastSuccessfulAt ?? '-');
  return {
    mark,
    title,
    fields: [
      hostField(target.host),
      [m['cli.agent.list.label_installation'](), target.marker?.installationId ?? '-'],
      [m['cli.agent.list.label_adapter'](), target.marker?.adapterVersion ?? '-'],
      [
        m['cli.agent.list.label_endpoint'](),
        `${target.marker?.endpoint ?? '-'} (${endpointMatch(target.endpointMatches)})`,
      ],
      [m['cli.agent.list.label_catalog'](), m['cli.agent.list.catalog_value']({ catalog, lastSuccessfulAt })],
      ...accessFields(target),
    ],
    notes: target.target === 'grok' ? grokNotes(style, target) : [],
  };
}

function codexBlock(style: Style, codex: CodexListResult): Block {
  const attention =
    codex.status === 'modified' ||
    codex.status === 'conflict' ||
    codex.connection === 'offline' ||
    codex.connection === 'unauthorized' ||
    codex.connection === 'invalid_response';
  const changedPaths =
    codex.changedPaths.length === 0 ? '-' : codex.changedPaths.map((path) => path.join('.')).join(', ');
  const fields: Field[] = [
    [m['cli.agent.list.label_config'](), codex.configPath],
    [m['cli.agent.list.label_provider'](), codex.providerId ?? '-'],
    [m['cli.agent.list.label_active_provider'](), codex.activeProviderId || '-'],
    [m['cli.agent.list.label_base_url'](), codex.baseUrl ?? '-'],
    [m['cli.agent.list.label_connection'](), codex.connection],
    [m['cli.agent.list.label_changed_paths'](), changedPaths],
  ];
  if (codex.authMode !== undefined) {
    fields.push(
      [m['cli.agent.list.label_auth_mode'](), codex.authMode],
      [m['cli.agent.list.label_installation'](), codex.installationId ?? '-'],
      [m['cli.agent.list.label_lifecycle'](), codex.lifecycle ?? '-'],
      [m['cli.agent.list.label_authorization'](), codex.authorization ?? 'not_checked'],
      [m['cli.agent.list.label_credential'](), codex.credentialStatus ?? '-'],
    );
  }
  return {
    mark: codex.status === 'absent' ? style.mark('off') : style.mark(attention ? 'warn' : 'ok'),
    title: `${style.strong('codex')}  ${codex.status}`,
    fields,
  };
}

function claudeCodeBlock(style: Style, claudeCode: ClaudeCodeListResult): Block {
  const attention =
    claudeCode.status !== 'managed' ||
    claudeCode.endpointMatches === false ||
    (claudeCode.connection !== 'ok' && claudeCode.connection !== 'not_checked');
  return {
    mark: claudeCode.status === 'absent' ? style.mark('off') : style.mark(attention ? 'warn' : 'ok'),
    title: `${style.strong('claude-code')}  ${claudeCode.status}`,
    fields: [
      [m['cli.agent.list.label_config'](), claudeCode.configPath],
      [
        m['cli.agent.list.label_base_url'](),
        `${claudeCode.baseUrl ?? '-'} (${endpointMatch(claudeCode.endpointMatches)})`,
      ],
      [m['cli.agent.list.label_credential'](), claudeCode.credential ?? '-'],
      [m['cli.agent.list.label_connection'](), claudeCode.connection],
      [m['cli.agent.list.label_changed_paths'](), claudeCode.changedPaths.join(', ') || '-'],
    ],
  };
}

export function renderAgentList(result: AgentListResult, json: boolean, style: Style = plainStyle): string[] {
  if (json) return [JSON.stringify(result)];
  const lines = formatBlocks(style, [
    ...result.targets.map((target) => targetBlock(style, target)),
    codexBlock(style, result.codex),
    claudeCodeBlock(style, result.claudeCode),
  ]);
  const control = [
    ...(result.server === 'not_checked' ? [] : [m['cli.agent.list.server']({ status: result.server })]),
    ...(result.deviceAuthorization === undefined || result.catalogSchemaVersions === undefined
      ? []
      : [
          m['cli.agent.list.capabilities']({
            deviceAuthorization: result.deviceAuthorization,
            catalogSchemaVersions:
              result.catalogSchemaVersions.length === 0 ? 'none' : result.catalogSchemaVersions.join(','),
          }),
        ]),
  ];
  if (control.length > 0) lines.push('', style.heading(m['cli.agent.list.section_control_plane']()), ...control);
  const authorizations = result.authorizations ?? [];
  if (authorizations.length > 0) {
    lines.push(
      '',
      style.heading(m['cli.agent.list.section_authorizations']()),
      ...formatTable(
        style,
        authorizations.map((item) => ({ cells: [item.installationId, item.target, item.authorization, item.local] })),
        [
          m['cli.agent.list.label_installation'](),
          m['cli.agent.list.label_target'](),
          m['cli.agent.list.label_authorization'](),
          m['cli.agent.list.label_local'](),
        ],
      ),
    );
  }
  return lines;
}

export function renderAgentConfigure(result: AgentConfigureResult, style: Style = plainStyle): string[] {
  if (result.target === 'codex') return renderCodexConfigure(result, style);
  if (result.target === 'claude-code') return renderClaudeCodeConfigure(result, style);
  const lines = [
    result.status === 'newer'
      ? `${style.mark('warn')} ${m['cli.agent.configure.newer']({ target: result.target })}`
      : `${style.mark('ok')} ${m['cli.agent.configure.result']({ target: result.target, status: result.status })}`,
  ];
  if (result.host.support === 'unsupported') {
    lines.push(
      m['cli.agent.configure.unsupported']({
        target: result.target,
        version: result.host.version ?? 'unknown',
        minimum: result.host.minimumVersion,
      }),
    );
  } else if (result.host.support === 'unknown') {
    lines.push(m['cli.agent.configure.version_unknown']({ target: result.target }));
  }
  if (result.server === 'unreachable') lines.push(m['cli.agent.configure.server_offline']());
  if (result.deviceAuthorization === 'password_required') lines.push(m['cli.agent.configure.password_required']());
  if (result.loginCommand === 'grok login') {
    lines.push(m['cli.agent.grok_login']());
    lines.push(m['cli.agent.grok_models']());
    lines.push(m['cli.agent.grok_close_settings']());
  } else {
    lines.push(m['cli.agent.configure.login']({ command: result.loginCommand }));
  }
  lines.push(m['cli.agent.configure.reload']({ target: result.target }));
  return lines;
}

export const renderAgentRemove = (result: AgentRemoveResult, style: Style = plainStyle): string[] => {
  if (result.target === 'codex') return renderCodexRemove(result, style);
  if (result.target === 'claude-code') return renderClaudeCodeRemove(result, style);
  const lines = [
    `${style.mark('ok')} ${m['cli.agent.remove.success']({ target: result.target, installationId: result.installationId })}`,
  ];
  if (result.target === 'grok' && result.skippedFields !== undefined && result.skippedFields.length > 0) {
    lines.push(m['cli.agent.grok_skipped_fields']({ fields: result.skippedFields.join(', ') }));
  }
  if (result.target === 'grok' && result.retainedFiles !== undefined && result.retainedFiles.length > 0) {
    lines.push(m['cli.agent.grok_retained_files']({ files: result.retainedFiles.join(', ') }));
  }
  return lines;
};
export const renderAgentRevoke = (result: AgentRevokeResult, style: Style = plainStyle): string[] => [
  `${style.mark('ok')} ${m['cli.agent.revoke.success']({ installationId: result.installationId, status: result.status })}`,
];

export type AgentCliActions = {
  readonly list: (options: {
    readonly check: boolean;
    readonly authorizations: boolean;
    readonly json: boolean;
  }) => Promise<AgentListResult>;
  readonly configure: (target: string, options?: CodexConfigureOptions) => Promise<AgentConfigureResult>;
  readonly remove: (target: string) => Promise<AgentRemoveResult>;
  readonly revoke: (installationId: string) => Promise<AgentRevokeResult>;
  readonly authCodex?: (installationId: string) => Promise<void>;
  readonly auth?: (target: string, options: { readonly installationId: string }) => Promise<void>;
};

export function registerAgentCommands(
  program: Command,
  input: { readonly actions: AgentCliActions; readonly print: (line: string) => void },
): void {
  const style = createStyle(process.stdout);
  const emit = (lines: readonly string[]): void => {
    for (const line of lines) input.print(line);
  };
  const agent = program
    .command('agent')
    .helpGroup(m['cli.help.group_agents']())
    .description(m['cli.agent.description']());
  agent
    .command('list')
    .option('--check', m['cli.agent.list.option_check']())
    .option('--authorizations', m['cli.agent.list.option_authorizations']())
    .option('--json')
    .action(async (options) => {
      const normalized = {
        check: options.check === true,
        authorizations: options.authorizations === true,
        json: options.json === true,
      };
      emit(renderAgentList(await input.actions.list(normalized), normalized.json, style));
    });
  agent
    .command('configure <opencode|pi|omp|codex|grok|claude-code>')
    .option('--restore-migration <operation-id>', m['cli.agent.codex.restore_option']())
    .action(async (target, options) => {
      if (target !== 'codex' && options.restoreMigration !== undefined)
        throw new Error('--restore-migration is only supported for codex');
      emit(
        renderAgentConfigure(
          await input.actions.configure(target, {
            ...(options.restoreMigration === undefined ? {} : { restoreMigration: options.restoreMigration }),
          }),
          style,
        ),
      );
    });
  agent.command('remove <opencode|pi|omp|codex|grok|claude-code>').action(async (target) => {
    emit(renderAgentRemove(await input.actions.remove(target), style));
  });
  agent.command('revoke <installation-id>').action(async (installationId) => {
    emit(renderAgentRevoke(await input.actions.revoke(installationId), style));
  });
  agent
    .command('auth <codex|grok>')
    .requiredOption('--installation-id <uuid>', m['cli.agent.codex.auth_installation_option']())
    .action(async (target, options) => {
      const installationId = z.uuid().parse(options.installationId);
      if (target === 'codex') {
        if (input.actions.authCodex === undefined) throw new Error('Codex auth is unavailable');
        await input.actions.authCodex(installationId);
        return;
      }
      if (target !== 'grok' || input.actions.auth === undefined) throw new Error('Unsupported auth command target');
      await input.actions.auth(target, { installationId });
    });
}
