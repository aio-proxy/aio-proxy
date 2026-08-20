import { homedir } from 'node:os';

import {
  AgentRevokeResponseSchema,
  AgentTargetSchema,
  type AgentAdminSnapshot,
  type AgentInstallationSummary,
  type AgentRevokeStatus,
  type AgentTarget,
} from '@aio-proxy/types';

import packageJson from '../../package.json' with { type: 'json' };
import { defaultCliDeps, type CliDeps } from '../dashboard-assets';
import { agentFiles } from './assets';
import { readAgentAdminSnapshot, resolveAgentEndpoint, revokeAgentInstallation } from './control-plane';
import { detectAgentHost, resolveAgentLocation, type AgentHost, type AgentHostDeps, type AgentLocation } from './hosts';
import {
  inspectManagedInstallation,
  installManagedIntegration,
  removeManagedIntegration,
  type LocalIntegrationStatus,
} from './managed-installation';

const AGENT_TARGETS = ['opencode', 'pi', 'omp'] as const;

export type AgentCommandDeps = {
  readonly detectHost: (target: AgentTarget) => Promise<AgentHost>;
  readonly resolveLocation: (target: AgentTarget) => Promise<AgentLocation>;
  readonly inspect: (location: AgentLocation, now: () => number) => Promise<LocalIntegrationStatus>;
  readonly resolveEndpoint: () => Promise<string>;
  readonly install: typeof installManagedIntegration;
  readonly remove: typeof removeManagedIntegration;
  readonly readSnapshot: (endpoint: string) => Promise<AgentAdminSnapshot>;
  readonly revoke: (endpoint: string, installationId: string) => Promise<AgentRevokeStatus>;
  readonly readAssets: (target: AgentTarget) => Promise<ReadonlyMap<string, Uint8Array>>;
  readonly adapterVersion: string;
  readonly randomUUID: () => `${string}-${string}-${string}-${string}-${string}`;
  readonly now: () => number;
};

type AgentListTargetBase = {
  readonly target: AgentTarget;
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
};

export type AgentConfigureResult = {
  readonly target: AgentTarget;
  readonly host: AgentHost;
  readonly installed: true;
  readonly status: 'installed' | 'updated' | 'newer';
  readonly server: 'reachable' | 'unreachable';
  readonly deviceAuthorization?: AgentAdminSnapshot['deviceAuthorization'];
  readonly loginCommand: 'opencode auth login --provider aio-proxy' | '/login aio-proxy';
  readonly reloadRequired: true;
};

export type AgentRemoveResult = {
  readonly target: AgentTarget;
  readonly installationId: string;
  readonly revokeStatus: AgentRevokeStatus;
};

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
  };
};

const commandDeps = (deps?: AgentCommandDeps): AgentCommandDeps => deps ?? createAgentCommandDeps(defaultCliDeps);

const parseTarget = (target: string): AgentTarget => AgentTargetSchema.parse(target);

const loginCommand = (target: AgentTarget): AgentConfigureResult['loginCommand'] =>
  target === 'opencode' ? 'opencode auth login --provider aio-proxy' : '/login aio-proxy';

const requireDetectedHost = async (target: AgentTarget, deps: AgentCommandDeps): Promise<AgentHost> => {
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
  target: AgentTarget,
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
  let location: AgentLocation;
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
): readonly AgentAuthorizationListItem[] => {
  const configured = new Set(
    targets.flatMap((row) =>
      row.integration === 'managed' && row.marker !== undefined
        ? [localMarkerKey(row.marker.installationId, row.marker.agent)]
        : [],
    ),
  );
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
  const targets: AgentListTargetResult[] = [];
  for (const target of AGENT_TARGETS) {
    targets.push(await listTarget(target, configuredEndpoint, resolved));
  }

  const online = options.check === true || options.authorizations === true;
  if (!online) return { targets, server: 'not_checked' };

  if (configuredEndpoint === undefined) return { targets, server: 'unreachable' };
  let snapshot: AgentAdminSnapshot;
  try {
    snapshot = await resolved.readSnapshot(configuredEndpoint);
  } catch {
    return { targets, server: 'unreachable' };
  }

  return {
    targets: applySnapshot(targets, snapshot),
    server: 'reachable',
    deviceAuthorization: snapshot.deviceAuthorization,
    catalogSchemaVersions: snapshot.catalogSchemaVersions,
    ...(options.authorizations === true ? { authorizations: authorizationItems(targets, snapshot) } : {}),
  };
}

export async function agentConfigure(target: string, deps?: AgentCommandDeps): Promise<AgentConfigureResult> {
  const resolved = commandDeps(deps);
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

  let server: AgentConfigureResult['server'] = 'unreachable';
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
