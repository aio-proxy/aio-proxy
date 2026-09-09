import type { JsonValue, EntityBody, PendingReason, ActivationResult, LocalEntity } from '@aio-proxy/core';

export type OAuthActivationEvidence = {
  readonly plugin: string;
  readonly capability: string;
  readonly pluginVersion: string;
  readonly formatVersion: number;
  readonly phase: 'ready' | 'refreshing' | 'uncertain' | 'login-required';
  readonly multiDeviceEvidenceId?: string;
  /** The format advertised by the installed OAuth adapter. */
  readonly expectedFormatVersion?: number;
  /** The multi-device evidence advertised by the installed OAuth adapter. */
  readonly expectedMultiDeviceEvidenceId?: string;
};

export function readOAuthActivationEvidence(
  account: unknown,
  expectedFormatVersion: number | undefined,
  expectedMultiDeviceEvidenceId: string | undefined,
  entity?: LocalEntity,
): OAuthActivationEvidence | undefined {
  if (account === null || typeof account !== 'object' || Array.isArray(account)) return undefined;
  let value = account as Record<string, unknown>;
  if (entity !== undefined) {
    const owner = entity.oauth;
    if (owner?.mode !== 'shared' || entity.pendingReason !== null || owner.localRevision !== value['revision'])
      return undefined;
    value = {
      ...value,
      pluginVersion: owner.pluginVersion,
      formatVersion: owner.formatVersion,
      multiDeviceEvidenceId: owner.multiDeviceEvidenceId,
      phase: 'ready',
    };
  }
  const plugin = value['plugin'];
  const capability = value['capability'];
  const pluginVersion = value['pluginVersion'];
  const formatVersion = value['formatVersion'];
  const phase = value['phase'];
  const multiDeviceEvidenceId = value['multiDeviceEvidenceId'];
  if (
    typeof plugin !== 'string' ||
    typeof capability !== 'string' ||
    typeof pluginVersion !== 'string' ||
    typeof formatVersion !== 'number' ||
    !Number.isInteger(formatVersion) ||
    !['ready', 'refreshing', 'uncertain', 'login-required'].includes(phase as string) ||
    typeof multiDeviceEvidenceId !== 'string'
  ) {
    return undefined;
  }
  return {
    plugin,
    capability,
    pluginVersion,
    formatVersion,
    phase: phase as OAuthActivationEvidence['phase'],
    multiDeviceEvidenceId,
    expectedFormatVersion,
    expectedMultiDeviceEvidenceId,
  };
}

export type ActivationInput = {
  readonly raw: Record<string, JsonValue>;
  readonly body: EntityBody;
  readonly apply: (raw: Record<string, JsonValue>, origin: 'remote') => Promise<void>;
  readonly dependencies: {
    readonly installedPackages: ReadonlyMap<string, string>;
    readonly missingEnv: readonly string[];
    readonly oauthVerified: boolean;
    readonly credentialValid: boolean;
    readonly oauthEvidence?: OAuthActivationEvidence;
  };
};

function bodyValue(body: EntityBody): Record<string, JsonValue> | undefined {
  return typeof body.value === 'object' && body.value !== null && !Array.isArray(body.value)
    ? (body.value as Record<string, JsonValue>)
    : undefined;
}

/**
 * Check prerequisites before changing the running configuration. This function deliberately has
 * no side effects: the engine can persist the desired body while an installation or OAuth gate is
 * pending and retry the same body later.
 */
export async function checkPrerequisites(input: ActivationInput): Promise<PendingReason | undefined> {
  for (const dependency of input.body.dependencies) {
    const installed = input.dependencies.installedPackages.get(dependency.packageName);
    if (installed === undefined) return 'missing-plugin';
    if (installed !== dependency.version) return 'incompatible-version';
  }
  if (input.dependencies.missingEnv.length > 0) return 'missing-env';
  if (!input.dependencies.credentialValid) return 'invalid-credential';
  if (input.body.kind === 'provider' && bodyValue(input.body)?.['kind'] === 'oauth') {
    const value = bodyValue(input.body)!;
    const evidence = input.dependencies.oauthEvidence;
    if (!input.dependencies.oauthVerified) return 'oauth-unverified';
    if (evidence === undefined) return 'oauth-unverified';
    if (evidence.plugin !== value['plugin'] || evidence.capability !== value['capability']) {
      return 'invalid-credential';
    }
    const dependencyVersion = input.body.dependencies.find(
      (dependency) => dependency.packageName === evidence.plugin,
    )?.version;
    if (dependencyVersion === undefined || evidence.pluginVersion !== dependencyVersion) {
      return 'incompatible-version';
    }
    if (evidence.expectedFormatVersion === undefined || evidence.formatVersion !== evidence.expectedFormatVersion) {
      return 'incompatible-version';
    }
    if (
      evidence.phase !== 'ready' ||
      evidence.multiDeviceEvidenceId === undefined ||
      evidence.multiDeviceEvidenceId.length === 0 ||
      evidence.expectedMultiDeviceEvidenceId === undefined ||
      evidence.multiDeviceEvidenceId !== evidence.expectedMultiDeviceEvidenceId
    ) {
      return 'oauth-unverified';
    }
  }
  return undefined;
}

export async function activateDesired(input: ActivationInput): Promise<ActivationResult> {
  const pending = await checkPrerequisites(input);
  if (pending !== undefined) return { applied: false, pending };
  await input.apply(input.raw, 'remote');
  return { applied: true };
}
