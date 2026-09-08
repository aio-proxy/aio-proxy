import type { JsonValue, EntityBody, PendingReason, ActivationResult } from '@aio-proxy/core';

export type ActivationInput = {
  readonly raw: Record<string, JsonValue>;
  readonly body: EntityBody;
  readonly apply: (raw: Record<string, JsonValue>, origin: 'remote') => Promise<void>;
  readonly dependencies: {
    readonly installedPackages: ReadonlyMap<string, string>;
    readonly missingEnv: readonly string[];
    readonly oauthVerified: boolean;
    readonly credentialValid: boolean;
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
  if (
    input.body.kind === 'provider' &&
    bodyValue(input.body)?.['kind'] === 'oauth' &&
    !input.dependencies.oauthVerified
  ) {
    return 'oauth-unverified';
  }
  return undefined;
}

export async function activateDesired(input: ActivationInput): Promise<ActivationResult> {
  const pending = await checkPrerequisites(input);
  if (pending !== undefined) return { applied: false, pending };
  await input.apply(input.raw, 'remote');
  return { applied: true };
}
