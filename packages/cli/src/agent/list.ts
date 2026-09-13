import { AgentPluginTargetSchema, type AgentAdminSnapshot, type AgentPluginTarget } from '@aio-proxy/types';

import {
  commandDeps,
  type AgentAuthorizationListItem,
  type AgentCommandDeps,
  type AgentListResult,
  type AgentListTargetResult,
  type GrokAgentListTargetResult,
  type PluginAgentListTargetResult,
} from './agent';
import type { CodexListResult } from './codex';
import type { AgentPluginLocation } from './hosts';
import type { LocalIntegrationStatus } from './managed-installation';

const PLUGIN_TARGETS = AgentPluginTargetSchema.options;

const resolveConfiguredEndpoint = async (deps: AgentCommandDeps): Promise<string | undefined> => {
  try {
    return await deps.resolveEndpoint();
  } catch {
    return undefined;
  }
};

const endpointMatches = (
  markerEndpoint: string,
  configured: string | undefined,
): { readonly endpointMatches?: boolean } => {
  if (configured === undefined) return {};
  try {
    void new URL(markerEndpoint);
    return { endpointMatches: markerEndpoint === configured };
  } catch {
    return {};
  }
};

const listPluginTarget = async (
  target: AgentPluginTarget,
  configuredEndpoint: string | undefined,
  deps: AgentCommandDeps,
): Promise<PluginAgentListTargetResult> => {
  const host = await deps.detectHost(target);
  const base = {
    target,
    host,
    authorization: 'not_checked' as const,
    schemaCompatibility: 'not_checked' as const,
  };
  if (!host.detected) return { ...base, integration: 'unresolved', reason: 'host_missing' };
  let location: AgentPluginLocation;
  try {
    location = await deps.resolveLocation(target);
  } catch {
    return { ...base, integration: 'unresolved', reason: 'path_unavailable' };
  }
  let status: LocalIntegrationStatus;
  try {
    status = await deps.inspect(location, deps.now);
  } catch {
    return { ...base, integration: 'unresolved', reason: 'path_unavailable' };
  }
  return {
    ...base,
    ...status,
    ...(status.marker === undefined ? {} : endpointMatches(status.marker.endpoint, configuredEndpoint)),
  };
};

const grokListBase = (
  host: GrokAgentListTargetResult['host'],
): Omit<GrokAgentListTargetResult, 'integration' | 'configuration' | 'fields' | 'marker' | 'endpointMatches'> => ({
  target: 'grok',
  host,
  integrationKind: 'auth-command',
  authorization: 'not_checked',
  catalog: 'host_managed',
  schemaCompatibility: 'not_applicable',
});

const listGrokTarget = async (
  configuredEndpoint: string | undefined,
  deps: AgentCommandDeps,
): Promise<GrokAgentListTargetResult> => {
  const host = await deps.detectHost('grok');
  const base = grokListBase(host);
  let location: Awaited<ReturnType<AgentCommandDeps['resolveLocation']>>;
  try {
    location = await deps.resolveLocation('grok');
  } catch {
    return { ...base, integration: 'unresolved', configuration: 'missing', fields: [] };
  }
  try {
    const status = await deps.grok.inspect(location.hostRoot, deps.adapterVersion);
    return {
      ...base,
      ...status,
      ...(status.marker === undefined ? {} : endpointMatches(status.marker.endpoint, configuredEndpoint)),
    };
  } catch {
    return { ...base, integration: 'unresolved', configuration: 'missing', fields: [] };
  }
};

const localMarkerKey = (installationId: string, target: string): string => `${installationId}:${target}`;

const applyCheckedPlugin = (
  row: PluginAgentListTargetResult,
  authorization: PluginAgentListTargetResult['authorization'],
  schemaCompatibility: PluginAgentListTargetResult['schemaCompatibility'],
): PluginAgentListTargetResult => {
  if (row.integration !== 'managed' || row.marker === undefined) return row;
  return { ...row, authorization, schemaCompatibility };
};

const applySnapshot = (
  targets: readonly AgentListTargetResult[],
  snapshot: AgentAdminSnapshot,
): readonly AgentListTargetResult[] => {
  const schemaCompatibility = snapshot.catalogSchemaVersions.includes(1) ? 'compatible' : 'incompatible';
  return targets.map((row) => {
    if (row.target === 'grok') {
      if (row.integration !== 'managed' || row.marker === undefined) return row;
      const match = snapshot.installations.find(
        (item) => item.installationId === row.marker.installationId && item.target === row.marker.agent,
      );
      return { ...row, authorization: match?.authorization ?? 'missing' };
    }
    if (row.integration !== 'managed' || row.marker === undefined) return row;
    const { marker } = row;
    const match = snapshot.installations.find(
      (item) => item.installationId === marker.installationId && item.target === marker.agent,
    );
    return applyCheckedPlugin(row, match?.authorization ?? 'missing', schemaCompatibility);
  });
};

const authorizationItems = (
  targets: readonly AgentListTargetResult[],
  snapshot: AgentAdminSnapshot,
  codex: CodexListResult,
): readonly AgentAuthorizationListItem[] => {
  const configured = new Set(
    targets.flatMap((row) => {
      if (row.marker === undefined || row.integration !== 'managed') return [];
      return [localMarkerKey(row.marker.installationId, row.marker.agent)];
    }),
  );
  if (codex.installationId !== undefined) configured.add(localMarkerKey(codex.installationId, 'codex'));
  return snapshot.installations.map((item) => ({
    ...item,
    local: configured.has(localMarkerKey(item.installationId, item.target)) ? 'configured' : 'orphaned',
  }));
};

export async function agentList(
  options: { readonly check?: boolean; readonly authorizations?: boolean; readonly json?: boolean },
  deps?: AgentCommandDeps,
): Promise<AgentListResult> {
  void options.json;
  const resolved = commandDeps(deps);
  const configuredEndpoint = await resolveConfiguredEndpoint(resolved);
  let codex: CodexListResult;
  try {
    codex = await resolved.codex.list(options.check === true);
  } catch {
    codex = {
      target: 'codex',
      integration: 'static-config',
      configPath: '',
      activeProviderId: '',
      status: 'conflict',
      connection: 'not_checked',
      changedPaths: [],
    };
  }
  const targets: AgentListTargetResult[] = [];
  for (const target of PLUGIN_TARGETS) {
    targets.push(await listPluginTarget(target, configuredEndpoint, resolved));
  }
  targets.push(await listGrokTarget(configuredEndpoint, resolved));

  const online = options.check === true || options.authorizations === true;
  if (!online) return { targets, server: 'not_checked', codex };

  if (configuredEndpoint === undefined) return { targets, server: 'unreachable', codex };
  let snapshot: AgentAdminSnapshot;
  try {
    snapshot = await resolved.readSnapshot(configuredEndpoint);
  } catch {
    return { targets, server: 'unreachable', codex };
  }

  return {
    targets: applySnapshot(targets, snapshot),
    server: 'reachable',
    deviceAuthorization: snapshot.deviceAuthorization,
    catalogSchemaVersions: snapshot.catalogSchemaVersions,
    ...(options.authorizations === true ? { authorizations: authorizationItems(targets, snapshot, codex) } : {}),
    codex,
  };
}
