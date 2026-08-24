import { m } from '@aio-proxy/i18n';
import type { Command } from 'commander';

import type { AgentConfigureResult, AgentListResult, AgentRemoveResult, AgentRevokeResult } from './agent';

export function renderAgentList(result: AgentListResult, json: boolean): string[] {
  if (json) return [JSON.stringify(result)];
  const lines = result.targets.map((target) =>
    target.integration === 'unresolved'
      ? m['cli.agent.list.unresolved']({
          target: target.target,
          reason: target.reason,
          hostVersion: target.host.version ?? 'unknown',
          minimumVersion: target.host.minimumVersion,
          support: target.host.support,
          authorization: target.authorization,
          schemaCompatibility: target.schemaCompatibility,
        })
      : m['cli.agent.list.target']({
          target: target.target,
          hostVersion: target.host.version ?? 'unknown',
          minimumVersion: target.host.minimumVersion,
          support: target.host.support,
          integration: target.integration,
          installationId: target.marker?.installationId ?? '-',
          adapterVersion: target.marker?.adapterVersion ?? '-',
          endpoint: target.marker?.endpoint ?? '-',
          endpointMatch:
            target.endpointMatches === undefined ? 'unknown' : target.endpointMatches ? 'match' : 'mismatch',
          catalog: target.catalog,
          lastSuccessfulAt: target.lastSuccessfulAt ?? '-',
          authorization: target.authorization,
          schemaCompatibility: target.schemaCompatibility,
        }),
  );
  if (result.server !== 'not_checked') {
    lines.push(m['cli.agent.list.server']({ status: result.server }));
  }
  if (result.deviceAuthorization !== undefined && result.catalogSchemaVersions !== undefined) {
    lines.push(
      m['cli.agent.list.capabilities']({
        deviceAuthorization: result.deviceAuthorization,
        catalogSchemaVersions:
          result.catalogSchemaVersions.length === 0 ? 'none' : result.catalogSchemaVersions.join(','),
      }),
    );
  }
  for (const authorization of result.authorizations ?? []) {
    lines.push(
      m['cli.agent.list.authorization']({
        installationId: authorization.installationId,
        target: authorization.target,
        authorization: authorization.authorization,
        local: authorization.local,
      }),
    );
  }
  return lines;
}

export function renderAgentConfigure(result: AgentConfigureResult): string[] {
  const lines = [
    result.status === 'newer'
      ? m['cli.agent.configure.newer']({ target: result.target })
      : m['cli.agent.configure.result']({ target: result.target, status: result.status }),
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
  lines.push(m['cli.agent.configure.login']({ command: result.loginCommand }));
  lines.push(m['cli.agent.configure.reload']({ target: result.target }));
  return lines;
}

export const renderAgentRemove = (result: AgentRemoveResult): string[] => [
  m['cli.agent.remove.success']({ target: result.target, installationId: result.installationId }),
];
export const renderAgentRevoke = (result: AgentRevokeResult): string[] => [
  m['cli.agent.revoke.success']({ installationId: result.installationId, status: result.status }),
];

export type AgentCliActions = {
  readonly list: (options: {
    readonly check: boolean;
    readonly authorizations: boolean;
    readonly json: boolean;
  }) => Promise<AgentListResult>;
  readonly configure: (target: string) => Promise<AgentConfigureResult>;
  readonly remove: (target: string) => Promise<AgentRemoveResult>;
  readonly revoke: (installationId: string) => Promise<AgentRevokeResult>;
};

export function registerAgentCommands(
  program: Command,
  input: { readonly actions: AgentCliActions; readonly print: (line: string) => void },
): void {
  const emit = (lines: readonly string[]): void => {
    for (const line of lines) input.print(line);
  };
  const agent = program.command('agent').description(m['cli.agent.description']());
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
      emit(renderAgentList(await input.actions.list(normalized), normalized.json));
    });
  agent.command('configure <opencode|pi|omp>').action(async (target) => {
    emit(renderAgentConfigure(await input.actions.configure(target)));
  });
  agent.command('remove <opencode|pi|omp>').action(async (target) => {
    emit(renderAgentRemove(await input.actions.remove(target)));
  });
  agent.command('revoke <installation-id>').action(async (installationId) => {
    emit(renderAgentRevoke(await input.actions.revoke(installationId)));
  });
}
