import { homedir } from 'node:os';

import {
  AgentPluginTargetSchema,
  AgentRevokeResponseSchema,
  type AgentAdminSnapshot,
  type AgentInstallationSummary,
  type AgentPluginTarget,
  type AgentRevokeStatus,
  type AgentTarget,
} from '@aio-proxy/types';

import packageJson from '../../package.json' with { type: 'json' };
import { defaultCliDeps, type CliDeps } from '../dashboard-assets';
import { agentFiles } from './assets';
import {
  configureCodexAgent,
  listCodexAgent,
  removeCodexAgent,
  type CodexConfigureOptions,
  type CodexConfigureResult,
  type CodexListResult,
  type CodexRemoveResult,
} from './codex';
import { readAgentAdminSnapshot, resolveAgentEndpoint, revokeAgentInstallation } from './control-plane';
import {
  detectAgentHost,
  resolveAgentLocation,
  type AgentHost,
  type AgentHostDeps,
  type AgentPluginLocation,
} from './hosts';
import {
  inspectManagedInstallation,
  installManagedIntegration,
  removeManagedIntegration,
  type LocalIntegrationStatus,
} from './managed-installation';

const AGENT_TARGETS = AgentPluginTargetSchema.options;

export type AgentCommandDeps = {
  readonly detectHost: (target: AgentPluginTarget) => Promise<AgentHost>;
  readonly resolveLocation: (target: AgentPluginTarget) => Promise<AgentPluginLocation>;
  readonly inspect: (location: AgentPluginLocation, now: () => number) => Promise<LocalIntegrationStatus>;
  readonly resolveEndpoint: () => Promise<string>;
  readonly install: typeof installManagedIntegration;
  readonly remove: typeof removeManagedIntegration;
  readonly readSnapshot: (endpoint: string) => Promise<AgentAdminSnapshot>;
  readonly revoke: (endpoint: string, installationId: string) => Promise<AgentRevokeStatus>;
  readonly readAssets: (target: AgentPluginTarget) => Promise<ReadonlyMap<string, Uint8Array>>;
  readonly adapterVersion: string;
  readonly randomUUID: () => `${string}-${string}-${string}-${string}-${string}`;
  readonly now: () => number;
  readonly codex: {
    readonly configure: (options?: CodexConfigureOptions) => Promise<CodexConfigureResult>;
    readonly list: (check: boolean) => Promise<CodexListResult>;
    readonly remove: () => Promise<CodexRemoveResult>;
  };
};

type AgentListTargetBase = {
  readonly target: AgentPluginTarget;
  readonly host: AgentHost;
  readonly authorization: 'not_checked' | AgentInstallationSummary['authorization'] | 'missing';
  readonly schemaCompatibility: 'not_checked' | 'compatible' | 'incompatible';
};

export type AgentListTargetResult = AgentListTargetBase &
  (
    | {
        readonly integration: 'unresolved';
        readonly reason: 'host_missing' | 'path_unavailable';
      }
    | ({ readonly integration: LocalIntegrationStatus['integration'] } & Omit<LocalIntegrationStatus, 'integration'> & {
          readonly endpointMatches?: boolean;
        })
  );

export type AgentAuthorizationListItem = AgentInstallationSummary & {
  readonly local: 'configured' | 'orphaned';
};

export type AgentListResult = {
  readonly targets: readonly AgentListTargetResult[];
  readonly server: 'not_checked' | 'reachable' | 'unreachable';
  readonly deviceAuthorization?: AgentAdminSnapshot['deviceAuthorization'];
  readonly catalogSchemaVersions?: readonly number[];
  readonly authorizations?: readonly AgentAuthorizationListItem[];
  readonly codex: CodexListResult;
};

export type PluginAgentConfigureResult = {
  readonly target: AgentPluginTarget;
  readonly host: AgentHost;
  readonly installed: true;
  readonly status: 'installed' | 'updated' | 'newer';
  readonly server: 'reachable' | 'unreachable';
  readonly deviceAuthorization?: AgentAdminSnapshot['deviceAuthorization'];
  readonly loginCommand: 'opencode auth login --provider aio-proxy' | '/login aio-proxy';
  readonly reloadRequired: true;
};

export type PluginAgentRemoveResult = {
  readonly target: AgentPluginTarget;
  readonly installationId: string;
  readonly revokeStatus: AgentRevokeStatus;
};

export type AgentConfigureResult = PluginAgentConfigureResult | CodexConfigureResult;
export type AgentRemoveResult = PluginAgentRemoveResult | CodexRemoveResult;

export type AgentRevokeResult = {
  readonly installationId: string;
  readonly status: AgentRevokeStatus;
};

const captureHostCommand = async (command: readonly [string, ...string[]]): Promise<string> => {
  const proc = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`${command[0]} command failed`);
  return stdout;
};

const hostDeps = (): AgentHostDeps => ({
  which: Bun.which,
  capture: captureHostCommand,
  env: process.env,
  home: homedir(),
});

export const createAgentCommandDeps = (cliDeps: CliDeps): AgentCommandDeps => {
  const hosts = hostDeps();
  return {
    detectHost: (target) => detectAgentHost(target, hosts),
    resolveLocation: (target) => resolveAgentLocation(target, hosts),
    inspect: inspectManagedInstallation,
    resolveEndpoint: resolveAgentEndpoint,
    install: installManagedIntegration,
    remove: removeManagedIntegration,
    readSnapshot: readAgentAdminSnapshot,
    revoke: revokeAgentInstallation,
    readAssets: (target) => agentFiles(target, cliDeps.agentAssetPaths()),
    adapterVersion: packageJson.version,
    randomUUID: () => crypto.randomUUID(),
    now: () => Date.now(),
    codex: {
      configure: configureCodexAgent,
      list: listCodexAgent,
      remove: removeCodexAgent,
    },
  };
};

const commandDeps = (deps?: AgentCommandDeps): AgentCommandDeps => deps ?? createAgentCommandDeps(defaultCliDeps);

const parseTarget = (target: string): AgentPluginTarget => AgentPluginTargetSchema.parse(target);

const loginCommand = (target: AgentPluginTarget): PluginAgentConfigureResult['loginCommand'] =>
  target === 'opencode' ? 'opencode auth login --provider aio-proxy' : '/login aio-proxy';

const requireDetectedHost = async (target: AgentPluginTarget, deps: AgentCommandDeps): Promise<AgentHost> => {
  const host = await deps.detectHost(target);
  if (!host.detected) throw new Error(`${target} is not installed`);
  return host;
};

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

const listTarget = async (
  target: AgentPluginTarget,
  configuredEndpoint: string | undefined,
  deps: AgentCommandDeps,
): Promise<AgentListTargetResult> => {
  const host = await deps.detectHost(target);
  const base: AgentListTargetBase = {
    target,
    host,
    authorization: 'not_checked',
    schemaCompatibility: 'not_checked',
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

const localMarkerKey = (installationId: string, target: AgentTarget): string => `${installationId}:${target}`;

const applyCheckedMarker = (
  row: AgentListTargetResult,
  authorization: AgentListTargetResult['authorization'],
  schemaCompatibility: AgentListTargetResult['schemaCompatibility'],
): AgentListTargetResult => {
  if (row.integration !== 'managed' || row.marker === undefined) return row;
  return { ...row, authorization, schemaCompatibility };
};

const applySnapshot = (
  targets: readonly AgentListTargetResult[],
  snapshot: AgentAdminSnapshot,
): readonly AgentListTargetResult[] => {
  const schemaCompatibility = snapshot.catalogSchemaVersions.includes(1) ? 'compatible' : 'incompatible';
  return targets.map((row) => {
    if (row.integration !== 'managed' || row.marker === undefined) return row;
    const { marker } = row;
    const match = snapshot.installations.find(
      (item) => item.installationId === marker.installationId && item.target === marker.agent,
    );
    return applyCheckedMarker(row, match?.authorization ?? 'missing', schemaCompatibility);
  });
};

const authorizationItems = (
  targets: readonly AgentListTargetResult[],
  snapshot: AgentAdminSnapshot,
  codex: CodexListResult,
): readonly AgentAuthorizationListItem[] => {
  const configured = new Set(
    targets.flatMap((row) =>
      row.integration === 'managed' && row.marker !== undefined
        ? [localMarkerKey(row.marker.installationId, row.marker.agent)]
        : [],
    ),
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
  for (const target of AGENT_TARGETS) {
    targets.push(await listTarget(target, configuredEndpoint, resolved));
  }

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

export async function agentConfigure(
  target: string,
  optionsOrDeps?: CodexConfigureOptions | AgentCommandDeps,
  suppliedDeps?: AgentCommandDeps,
): Promise<AgentConfigureResult> {
  const options =
    suppliedDeps === undefined && optionsOrDeps !== undefined && !('detectHost' in optionsOrDeps) ? optionsOrDeps : {};
  const deps =
    suppliedDeps ?? (optionsOrDeps !== undefined && 'detectHost' in optionsOrDeps ? optionsOrDeps : undefined);
  const resolved = commandDeps(deps);
  if (target === 'codex') return resolved.codex.configure(options);
  if (options.restoreMigration !== undefined) throw new Error('--restore-migration is only supported for codex');
  const parsed = parseTarget(target);
  const host = await requireDetectedHost(parsed, resolved);
  const location = await resolved.resolveLocation(parsed);
  const existing = await resolved.inspect(location, resolved.now);
  const endpoint = await resolved.resolveEndpoint();
  const requestedInstallationId =
    existing.integration === 'managed' && existing.marker !== undefined
      ? existing.marker.installationId
      : resolved.randomUUID();
  const status = await resolved.install({
    location,
    endpoint,
    adapterVersion: resolved.adapterVersion,
    requestedInstallationId,
    readAssets: () => resolved.readAssets(parsed),
  });

  let server: PluginAgentConfigureResult['server'] = 'unreachable';
  let deviceAuthorization: AgentAdminSnapshot['deviceAuthorization'] | undefined;
  try {
    const snapshot = await resolved.readSnapshot(endpoint);
    server = 'reachable';
    deviceAuthorization = snapshot.deviceAuthorization;
  } catch {
    // Offline configure still keeps the local installation.
  }

  return {
    target: parsed,
    host,
    installed: true,
    status,
    server,
    ...(deviceAuthorization === undefined ? {} : { deviceAuthorization }),
    loginCommand: loginCommand(parsed),
    reloadRequired: true,
  };
}

export async function agentRemove(target: string, deps?: AgentCommandDeps): Promise<AgentRemoveResult> {
  const resolved = commandDeps(deps);
  if (target === 'codex') return resolved.codex.remove();
  const parsed = parseTarget(target);
  await requireDetectedHost(parsed, resolved);
  const location = await resolved.resolveLocation(parsed);
  const status = await resolved.inspect(location, resolved.now);
  if (status.integration !== 'managed' || status.marker === undefined) {
    throw new Error('managed installation is required');
  }
  const revokeStatus = await resolved.revoke(status.marker.endpoint, status.marker.installationId);
  await resolved.remove(location, status.marker.installationId);
  return { target: parsed, installationId: status.marker.installationId, revokeStatus };
}

export async function agentRevoke(installationId: string, deps?: AgentCommandDeps): Promise<AgentRevokeResult> {
  const resolved = commandDeps(deps);
  const id = AgentRevokeResponseSchema.shape.installationId.parse(installationId);
  return { installationId: id, status: await resolved.revoke(await resolved.resolveEndpoint(), id) };
}
