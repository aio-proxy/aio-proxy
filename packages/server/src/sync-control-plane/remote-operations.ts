import { randomUUID } from 'node:crypto';

import {
  createSyncObjectStore,
  deleteEntity,
  publishEntity,
  purgeEntity,
  restoreEntity,
  SyncProtocolError,
  type EntityBody,
  type LocalEntity,
} from '@aio-proxy/core';
import type { SyncSession } from '@aio-proxy/plugin-sdk';

import { SyncOperationError } from './operations';

export type RemoteOperations = {
  readonly restore: (
    objectId: string,
    body: EntityBody,
    operationId: string,
    current: LocalEntity | undefined,
    expected: string | null,
  ) => Promise<void>;
  readonly purge: (objectId: string, expected: string | null) => Promise<void>;
  /** Resolves to the new head's operation ID, which is the baseline the local row must record. */
  readonly publish: (
    body: EntityBody | null,
    current: LocalEntity | undefined,
    expected: string | null,
  ) => Promise<string | null>;
};

// The publication helpers gained an optional expected-version argument after their public
// signatures were fixed. Casting here keeps the conditional writes without widening the exported
// core contract for every caller that does not fence.
const restoreWithExpected = restoreEntity as unknown as (
  store: Parameters<typeof restoreEntity>[0],
  objectId: string,
  body: EntityBody,
  operationId: string,
  signal: AbortSignal,
  expected: string | null,
) => Promise<unknown>;
const purgeWithExpected = purgeEntity as unknown as (
  store: Parameters<typeof purgeEntity>[0],
  objectId: string,
  signal: AbortSignal,
  expected: string | null,
) => Promise<unknown>;
const deleteWithExpected = deleteEntity as unknown as (
  store: Parameters<typeof deleteEntity>[0],
  objectId: string,
  epoch: number,
  signal: AbortSignal,
  expected: string | null,
) => Promise<unknown>;
const publishWithExpected = publishEntity as unknown as (
  store: Parameters<typeof publishEntity>[0],
  operation: Parameters<typeof publishEntity>[1],
  signal: AbortSignal,
  expected: string | null,
) => Promise<unknown>;

async function conditional<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SyncProtocolError && error.code === 'upgrade-required')
      throw new SyncOperationError('operation-pending');
    throw error;
  }
}

/** The default remote half of the control plane operations, written straight through a session. */
export function createRemoteOperations(session: SyncSession | undefined): RemoteOperations {
  if (session === undefined) throw new SyncOperationError('not-connected');
  const store = createSyncObjectStore(session);
  const signal = new AbortController().signal;
  return {
    async restore(objectId, body, operationId, _current, expected) {
      await conditional(() => restoreWithExpected(store, objectId, body, operationId, signal, expected));
    },
    async purge(objectId, expected) {
      await conditional(() => purgeWithExpected(store, objectId, signal, expected));
    },
    async publish(body, current, expected) {
      if (current === undefined) throw new SyncOperationError('operation-pending');
      const objectId = current.objectId;
      if (body === null) {
        await conditional(() => deleteWithExpected(store, objectId, current.epoch, signal, expected));
        return null;
      }
      const operationId = randomUUID();
      await conditional(() =>
        publishWithExpected(
          store,
          {
            operationId,
            objectId,
            epoch: current.epoch,
            kind: 'put',
            body,
            commitId: `control:${randomUUID()}`,
          },
          signal,
          expected,
        ),
      );
      return operationId;
    },
  };
}
