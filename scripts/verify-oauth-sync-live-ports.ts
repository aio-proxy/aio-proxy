import { decodeAccount, type LiveAccount } from '../packages/core/src/sync/oauth/protocol';
import { accountKey } from '../packages/core/src/sync/protocol/protocol';
import type { CredentialPort, OAuthAdapter, RuntimeFetch, SyncSession } from '../packages/plugin-sdk/src';

export async function readRemote(session: SyncSession, objectId: string, signal: AbortSignal) {
  const value = await session.read(accountKey(objectId), signal);
  if (value.kind === 'absent') return null;
  const account = decodeAccount(value.value);
  if ('phase' in account && account.phase === 'deleted') return null;
  return { account: account as LiveAccount, version: value.version };
}

function credentialPort(value: unknown): CredentialPort<unknown> {
  return {
    async read() {
      return { value, revision: 1 };
    },
    async refresh() {
      throw new Error('runner-owned-refresh');
    },
  };
}

export async function discover(adapter: OAuthAdapter, account: LiveAccount, signal: AbortSignal): Promise<void> {
  await adapter.catalog.discover({
    credentials: credentialPort(account.payload.credential),
    options: account.payload.options,
    signal,
    fetch: globalThis.fetch as RuntimeFetch,
  });
}

export function copiedAccount(account: LiveAccount, credential: LiveAccount['payload']['credential']): LiveAccount {
  return { ...account, payload: { ...account.payload, credential } };
}
