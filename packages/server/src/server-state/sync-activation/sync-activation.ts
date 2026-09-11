import {
  collectMissingTemplateEnv,
  parsePluginSchema,
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

export function createActivationCheck(input: ActivationCheckInput) {
  return async (raw: Record<string, JsonValue>, body: EntityBody) => {
    const missingEnv = templateEnv(body);
    if (missingEnv === 'invalid-config') return missingEnv;
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
            ?.receive(body.logicalKey, { adapter, pluginVersion }, new AbortController().signal)
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
        const currentBinding = input.repo.readBinding();
        oauthEvidence = readOAuthActivationEvidence(
          account,
          adapter.credentialSync?.formatVersion,
          adapter.credentialSync?.multiDevice?.evidenceId,
          currentBinding === null
            ? undefined
            : input.repo
                .entities(currentBinding.id)
                .find((entity) => entity.kind === 'provider' && entity.logicalKey === body.logicalKey),
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
