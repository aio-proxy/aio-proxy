import {
  type LocalizedText,
  LocalizedTextSchema,
  type SyncBackendDefinition,
  type SyncSession,
} from '@aio-proxy/plugin-sdk';
import { isRecord } from '@aio-proxy/shared';
import { CapabilityIdSchema } from '@aio-proxy/types';

import { validateConfigSpec } from '../config-spec';

function invalidBackend(): never {
  throw new Error('Invalid sync backend');
}

function invalidSession(): never {
  throw new Error('Invalid sync session');
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function validateSyncSession(value: unknown): SyncSession {
  if (!isRecord(value)) invalidSession();
  const { identityId, spaceId, maxValueBytes, read, compareAndSwap, list, remove, watch, dispose } = value;
  if (
    !nonEmptyString(identityId) ||
    !nonEmptyString(spaceId) ||
    typeof maxValueBytes !== 'number' ||
    !Number.isFinite(maxValueBytes) ||
    !Number.isInteger(maxValueBytes) ||
    maxValueBytes <= 0 ||
    typeof read !== 'function' ||
    typeof compareAndSwap !== 'function' ||
    typeof list !== 'function' ||
    typeof remove !== 'function' ||
    typeof dispose !== 'function' ||
    (watch !== undefined && typeof watch !== 'function')
  ) {
    invalidSession();
  }
  return {
    identityId,
    spaceId,
    maxValueBytes,
    read: read.bind(value) as SyncSession['read'],
    compareAndSwap: compareAndSwap.bind(value) as SyncSession['compareAndSwap'],
    list: list.bind(value) as SyncSession['list'],
    remove: remove.bind(value) as SyncSession['remove'],
    ...(watch === undefined ? {} : { watch: watch.bind(value) as NonNullable<SyncSession['watch']> }),
    dispose: dispose.bind(value) as SyncSession['dispose'],
  };
}

export function validateSyncBackend(value: unknown): {
  readonly id: string;
  readonly backend: SyncBackendDefinition<unknown>;
} {
  if (!isRecord(value)) invalidBackend();
  const { id: rawId, displayName, options, connect } = value;
  const id = CapabilityIdSchema.parse(rawId);
  const validatedDisplayName = LocalizedTextSchema.safeParse(displayName);
  if (!validatedDisplayName.success || typeof connect !== 'function') invalidBackend();
  const validatedOptions = validateConfigSpec(options).spec;
  return {
    id,
    backend: {
      id,
      displayName: validatedDisplayName.data as LocalizedText,
      options: validatedOptions,
      async connect(options, context) {
        return validateSyncSession(await connect.call(value, options, context));
      },
    },
  };
}
