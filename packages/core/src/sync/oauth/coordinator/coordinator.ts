import type { JsonValue } from '@aio-proxy/plugin-sdk';

import type { SyncObjectStore } from '../../publication';
import type { LocalBinding, OAuthJournalRow, SyncRepository } from '../../repository';
import type { LiveAccount } from '../protocol';
import { recoverAccount } from './recovery';
import { refreshAccount, type CoordinatorContext } from './refresh';

export type ExchangeResult<C> = {
  value: C;
  metadata?: { accountLabel?: string; expiresAt?: number };
};

export interface SharedRefreshInput<C> {
  objectId: string;
  epoch: number;
  generation: number;
  exchange(current: C, signal: AbortSignal): Promise<ExchangeResult<C>>;
  validate(value: unknown): Promise<C>;
}

export type SharedRefreshResult<C> = {
  status: 'updated' | 'superseded';
  account: LiveAccount;
  value: C;
};

export interface SharedOAuthCoordinator {
  refresh<C>(input: SharedRefreshInput<C>, signal: AbortSignal): Promise<SharedRefreshResult<C>>;
  recover(objectId: string, signal: AbortSignal): Promise<LiveAccount | null>;
}

export type SharedOAuthCoordinatorInput = {
  binding: LocalBinding;
  store: SyncObjectStore;
  repo: SyncRepository;
};

export function createSharedOAuthCoordinator(input: SharedOAuthCoordinatorInput): SharedOAuthCoordinator {
  const context: CoordinatorContext = {
    binding: input.binding,
    store: input.store,
    repo: input.repo,
    pendingResults: new Map(),
  };
  return {
    refresh<C>(request: SharedRefreshInput<C>, signal: AbortSignal) {
      return refreshAccount(context, request, signal);
    },
    recover(objectId, signal) {
      return recoverAccount(context, objectId, signal);
    },
  };
}

export type { CoordinatorContext, OAuthJournalRow, JsonValue };
