import {
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
export function createActivationCheck(input: ActivationCheckInput) {
  return async (raw: Record<string, JsonValue>, body: EntityBody) => {
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
        missingEnv: [],
        oauthVerified: credentialValid,
        credentialValid,
        ...(oauthEvidence === undefined ? {} : { oauthEvidence }),
      },
    });
  };
}
