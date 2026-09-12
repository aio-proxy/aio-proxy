import {
  collectMissingTemplateEnv,
  parsePluginSchema,
  resolveConfigTemplates,
  type EntityBody,
  type JsonValue,
  type OAuthSharingService,
  type PluginRegistrySnapshot,
  type PluginRepository,
  type StoredAccount,
  type SyncRepository,
} from '@aio-proxy/core';

import {
  checkPrerequisites,
  readOAuthActivationEvidence,
  type OAuthActivationEvidence,
} from '../../sync-control-plane';

export type ActivationCheckInput = {
  readonly repo: SyncRepository;
  readonly accounts: PluginRepository;
  readonly plugins: () => PluginRegistrySnapshot;
  readonly pluginVersions: () => ReadonlyMap<string, string>;
  readonly sharing: () => OAuthSharingService | undefined;
};

const stringField = (record: Record<string, JsonValue>, key: string): string | undefined =>
  typeof record[key] === 'string' ? (record[key] as string) : undefined;

const oauthProviderRecord = (body: EntityBody): Record<string, JsonValue> | undefined => {
  const value = body.value;
  if (body.kind !== 'provider' || value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  return record['kind'] === 'oauth' ? record : undefined;
};

/**
 * Decides whether a synchronized entity may activate locally. An OAuth Provider arriving from
 * another device has no local account yet, so its separately published account object is imported
 * first: without that the prerequisite check below would reject the Provider forever.
 */
/**
 * The environment references the incoming body carries. A published body keeps `{{env.NAME}}`
 * unresolved so each device answers for itself, so this has to read the body: scanning the running
 * configuration instead answers for Providers the remote entity is not replacing.
 */
function templateEnv(body: EntityBody): 'invalid-config' | readonly string[] {
  try {
    return collectMissingTemplateEnv(body.value);
  } catch {
    // A template this device cannot parse would fail the whole configuration on its next load.
    return 'invalid-config';
  }
}

/** Every `{{env.NAME}}` the body references, defined locally or not. */
function envReferences(body: EntityBody): ReadonlySet<string> {
  const names = new Set<string>();
  resolveConfigTemplates(body.value, process.env, (name) => names.add(name));
  return names;
}

/**
 * Everywhere a body could send a request, and therefore any secret it carries. Collected by shape
 * rather than by schema field so a new endpoint option cannot quietly open an unchecked sink:
 * anything under a destination key, plus any URL-shaped string at any depth.
 */
function destinations(value: JsonValue, found: Set<string> = new Set()): ReadonlySet<string> {
  if (typeof value === 'string') {
    if (value.includes('://')) found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) destinations(item, found);
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'baseURL' || key === 'proxy') found.add(`${key}:${JSON.stringify(item)}`);
    destinations(item, found);
  }
  return found;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

/**
 * An environment reference is a device-only secret: the published body keeps `{{env.NAME}}`
 * unresolved, but this device expands it and the transport sends the real value upstream. A writer
 * with access to the space can therefore keep the reference and repoint `baseURL` at its own origin
 * to exfiltrate the secret. Bind each reference to the destinations this device already accepted and
 * hold anything else for the user to approve in a preview — the reviewed apply path does not run
 * this check.
 */
function secretDestinationApproved(body: EntityBody, approved: EntityBody | null | undefined): boolean {
  try {
    if (envReferences(body).size === 0) return true;
    if (approved === null || approved === undefined) return false;
    return (
      sameSet(envReferences(body), envReferences(approved)) &&
      sameSet(destinations(body.value), destinations(approved.value))
    );
  } catch {
    return false;
  }
}

export function createActivationCheck(input: ActivationCheckInput) {
  return async (raw: Record<string, JsonValue>, body: EntityBody, signal: AbortSignal) => {
    const missingEnv = templateEnv(body);
    if (missingEnv === 'invalid-config') return missingEnv;
    const binding = input.repo.readBinding();
    const localEntity =
      binding === null
        ? undefined
        : input.repo
            .entities(binding.id)
            .find((entity) => entity.kind === body.kind && entity.logicalKey === body.logicalKey);
    // Only once the reference resolves: a variable this device never defined carries no secret to
    // redirect, and `missing-env` is the more useful answer for it.
    if (missingEnv.length === 0 && !secretDestinationApproved(body, localEntity?.desired)) return 'secret-conflict';
    let credentialValid = true;
    let oauthEvidence: OAuthActivationEvidence | undefined;
    const record = oauthProviderRecord(body);
    if (record !== undefined) {
      const plugin = stringField(record, 'plugin');
      const capability = stringField(record, 'capability');
      const adapter =
        plugin === undefined || capability === undefined
          ? undefined
          : input.plugins().registry.resolveOAuth(plugin, capability);
      const pluginVersion = plugin === undefined ? undefined : input.pluginVersions().get(plugin);
      let account: StoredAccount | null = input.accounts.readAccount(body.logicalKey);
      if (account === null && adapter !== undefined && pluginVersion !== undefined) {
        account =
          (await input
            .sharing()
            ?.receive(body.logicalKey, { adapter, pluginVersion }, signal)
            .catch(() => null)) ?? null;
      }
      if (
        plugin === undefined ||
        capability === undefined ||
        adapter === undefined ||
        account === null ||
        account.plugin !== plugin ||
        account.capability !== capability
      )
        credentialValid = false;
      else {
        credentialValid = (await parsePluginSchema(adapter.credentials, account.credential)).ok;
        oauthEvidence = readOAuthActivationEvidence(
          account,
          adapter.credentialSync?.formatVersion,
          adapter.credentialSync?.multiDevice?.evidenceId,
          localEntity,
        );
      }
    }
    return checkPrerequisites({
      raw,
      body,
      apply: async () => {},
      dependencies: {
        installedPackages: input.pluginVersions(),
        // An unresolved `{{env.NAME}}` resolves to an empty string, so a synchronized Provider
        // would replace a working configuration with an unauthenticated one on a device that
        // never defined the variable. Stay pending until it does.
        missingEnv,
        oauthVerified: credentialValid,
        credentialValid,
        ...(oauthEvidence === undefined ? {} : { oauthEvidence }),
      },
    });
  };
}
