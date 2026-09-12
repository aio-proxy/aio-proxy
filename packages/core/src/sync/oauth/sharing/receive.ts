import type { OAuthAdapter } from '@aio-proxy/plugin-sdk';

import type { StoredAccount } from '../../../plugins/repository';
import { parsePluginSchema } from '../../../plugins/schema';
import { canActivateSyncedAccount } from '../protocol';
import { entityFor, readRemote } from './detach';
import type { OAuthSharingServiceInput } from './sharing';
import { ownership } from './state';

/**
 * A device that discovers a synchronized OAuth Provider has no local account yet, so the separately
 * published account object is the only credential evidence it can validate. Import it under the
 * ownership the publishing device recorded; activation, sharing and refresh all read local state
 * afterwards and would otherwise reject the Provider forever.
 */
export async function importRemoteAccount(
  input: OAuthSharingServiceInput,
  providerId: string,
  resolved: { readonly adapter: OAuthAdapter; readonly pluginVersion: string },
  signal: AbortSignal,
): Promise<StoredAccount | null> {
  return input.withProviderGate(providerId, async () => {
    const existing = input.accounts.readAccount(providerId);
    if (existing !== null) return existing;
    const entity = entityFor(input.repo, input.binding, providerId);
    if (entity === undefined || input.repo.readBinding()?.id !== input.binding.id) return null;
    const remote = await readRemote(input.store, entity.objectId, signal);
    if (remote === null || 'unknown' in remote || 'deleted' in remote) return null;
    const account = remote.account;
    if (!canActivateSyncedAccount(resolved.adapter, resolved.pluginVersion, account)) return null;
    if (!(await parsePluginSchema(resolved.adapter.credentials, account.payload.credential)).ok) return null;
    return input.accounts.withAccountTransaction(() => {
      const current = entityFor(input.repo, input.binding, providerId);
      if (input.accounts.readAccount(providerId) !== null || current?.objectId !== entity.objectId) return null;
      const pending = input.accounts.stageAccountOperation({
        kind: 'create',
        targetDigest: `sync:${account.objectId}:${account.epoch}:${account.generation}`,
        account: {
          providerId,
          plugin: account.plugin,
          capability: account.capability,
          fingerprint: account.payload.fingerprint,
          options: account.payload.options,
          secrets: account.payload.secrets,
          credential: account.payload.credential,
          ...(account.payload.label === undefined ? {} : { label: account.payload.label }),
          ...(account.payload.expiresAt === undefined ? {} : { expiresAt: account.payload.expiresAt }),
          catalog: { kind: 'preserve' },
        },
      });
      input.accounts.completeAccountOperation(pending.operationId);
      const imported = input.accounts.readAccount(providerId);
      if (imported === null) return null;
      input.repo.putEntity(input.binding.id, {
        ...current,
        pendingReason: null,
        oauth: ownership(account, imported.revision, 'shared'),
      });
      return imported;
    });
  });
}
