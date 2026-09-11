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
import { resolveGrokExecutable } from '../executable';
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
  configureGrok,
  inspectGrok,
  loadGrokPolicy,
  removeGrok,
  type GrokDeps,
  type GrokInspection,
  type GrokMarker,
} from './grok';
import {
  detectAgentHost,
  resolveAgentLocation,
  type AgentHost,
  type AgentHostDeps,
  type AgentLocation,
  type AgentPluginLocation,
} from './hosts';
import {
  inspectManagedInstallation,
  installManagedIntegration,
  removeManagedIntegration,
  type LocalIntegrationStatus,
} from './managed-installation';

export type AgentCommandDeps = {
  readonly detectHost: (target: AgentTarget) => Promise<AgentHost>;
  readonly resolveLocation: {
    (target: AgentPluginTarget): Promise<AgentPluginLocation>;
    (target: AgentTarget): Promise<AgentLocation>;
  };
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
  readonly grok: {
    readonly configure: typeof configureGrok;
    readonly inspect: typeof inspectGrok;
    readonly remove: typeof removeGrok;
    readonly deps: GrokDeps;
    readonly resolveExecutable: () => Promise<string>;
  };
};

export type PluginAgentListTargetResult = {
  readonly target: AgentPluginTarget;
  readonly host: AgentHost;
  readonly authorization: 'not_checked' | AgentInstallationSummary['authorization'] | 'missing';
  readonly schemaCompatibility: 'not_checked' | 'compatible' | 'incompatible';
} & (
  | {
      readonly integration: 'unresolved';
      readonly reason: 'host_missing' | 'path_unavailable';
    }
  | ({ readonly integration: LocalIntegrationStatus['integration'] } & Omit<LocalIntegrationStatus, 'integration'> & {
        readonly endpointMatches?: boolean;
      })
);

export type GrokAgentListTargetResult = {
  readonly target: 'grok';
  readonly host: AgentHost;
  readonly integrationKind: 'auth-command';
  readonly integration: GrokInspection['integration'] | 'unresolved';
  readonly configuration: GrokInspection['configuration'];
  readonly marker?: GrokMarker;
  readonly fields: readonly string[];
  readonly authorization: 'not_checked' | AgentInstallationSummary['authorization'] | 'missing';
  readonly catalog: 'host_managed';
  readonly schemaCompatibility: 'not_applicable';
  readonly endpointMatches?: boolean;
};

export type AgentListTargetResult = PluginAgentListTargetResult | GrokAgentListTargetResult;

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

export type GrokAgentConfigureResult = {
  readonly target: 'grok';
  readonly host: AgentHost;
  readonly installed: true;
  readonly status: 'installed' | 'updated' | 'newer';
  readonly server: 'reachable' | 'unreachable';
  readonly deviceAuthorization?: AgentAdminSnapshot['deviceAuthorization'];
  readonly loginCommand: 'grok login';
  readonly reloadRequired: true;
};

export type PluginAgentRemoveResult = {
  readonly target: AgentPluginTarget;
  readonly installationId: string;
  readonly revokeStatus: AgentRevokeStatus;
};

export type GrokAgentRemoveResult = {
  readonly target: 'grok';
  readonly installationId: string;
  readonly revokeStatus: AgentRevokeStatus;
  readonly skippedFields?: readonly string[];
  readonly retainedFiles?: readonly string[];
};

export type AgentConfigureResult = PluginAgentConfigureResult | CodexConfigureResult | GrokAgentConfigureResult;
export type AgentRemoveResult = PluginAgentRemoveResult | CodexRemoveResult | GrokAgentRemoveResult;

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
    resolveLocation: ((target: AgentTarget) =>
      resolveAgentLocation(target, hosts)) as AgentCommandDeps['resolveLocation'],
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
    grok: {
      configure: configureGrok,
      inspect: inspectGrok,
      remove: removeGrok,
      deps: {
        now: () => Date.now(),
        randomUUID: () => crypto.randomUUID(),
        policy: loadGrokPolicy,
        revoke: revokeAgentInstallation,
      },
      resolveExecutable: () => resolveGrokExecutable(),
    },
  };
};

export const commandDeps = (deps?: AgentCommandDeps): AgentCommandDeps =>
  deps ?? createAgentCommandDeps(defaultCliDeps);

const parsePluginTarget = (target: string): AgentPluginTarget => AgentPluginTargetSchema.parse(target);

const loginCommand = (target: AgentPluginTarget): PluginAgentConfigureResult['loginCommand'] =>
  target === 'opencode' ? 'opencode auth login --provider aio-proxy' : '/login aio-proxy';

export const requireDetectedHost = async (target: AgentTarget, deps: AgentCommandDeps): Promise<AgentHost> => {
  const host = await deps.detectHost(target);
  if (!host.detected) throw new Error(`${target} is not installed`);
  return host;
};

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
  if (target === 'grok') {
    const host = await requireDetectedHost('grok', resolved);
    const location = await resolved.resolveLocation('grok');
    const endpoint = await resolved.resolveEndpoint();
    const installed = await resolved.grok.configure(
      {
        root: location.hostRoot,
        endpoint,
        executable: await resolved.grok.resolveExecutable(),
        adapterVersion: resolved.adapterVersion,
      },
      resolved.grok.deps,
    );
    const snapshot = await resolved.readSnapshot(endpoint).catch(() => undefined);
    return {
      target: 'grok',
      host,
      installed: true,
      status: installed.status,
      server: snapshot === undefined ? 'unreachable' : 'reachable',
      ...(snapshot === undefined ? {} : { deviceAuthorization: snapshot.deviceAuthorization }),
      loginCommand: 'grok login',
      reloadRequired: true,
    };
  }
  const parsed = parsePluginTarget(target);
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
  if (target === 'grok') {
    const location = await resolved.resolveLocation('grok');
    const removed = await resolved.grok.remove(location.hostRoot, resolved.adapterVersion, resolved.grok.deps);
    return {
      target: 'grok',
      installationId: removed.installationId,
      revokeStatus: removed.revokeStatus,
      ...(removed.skippedFields.length === 0 ? {} : { skippedFields: removed.skippedFields }),
      ...(removed.retainedFiles.length === 0 ? {} : { retainedFiles: removed.retainedFiles }),
    };
  }
  const parsed = parsePluginTarget(target);
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
