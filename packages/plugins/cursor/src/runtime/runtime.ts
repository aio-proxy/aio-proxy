import type { JsonValue, OAuthRuntimeResult, RuntimeContext } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import type { CursorOAuthDependencies } from '../oauth';
import type { CursorCredential } from '../schema';
import { CursorSessionStore } from '../store/session-store/index';
import { CURSOR_API_URL, createNodeHttp2Transport, type CursorTransport } from '../wire/transport/index';
import { createCursorProviderV4, type CursorModelDescriptor } from './provider/index';

export type CursorRuntimeDependencies = CursorOAuthDependencies & {
  readonly transport?: CursorTransport;
  readonly sessionStore?: CursorSessionStore;
};

// One transport + one session store per runtime (per account), never per request
// and never module-global. Returns { provider } only: Cursor has no raw
// passthrough (not a ProtocolId) and no separate token-count endpoint.
export function createCursorRuntime(
  context: RuntimeContext<CursorCredential, Record<string, never>>,
  dependencies: CursorRuntimeDependencies = {},
): Promise<OAuthRuntimeResult> {
  const { transport: injectedTransport, sessionStore: injectedStore, ...injectedCredentialOptions } = dependencies;
  const credentialOptions: CursorOAuthDependencies = {
    ...injectedCredentialOptions,
    ...(injectedCredentialOptions.fetch === undefined ? { fetch: context.fetch } : {}),
  };
  const transport = injectedTransport ?? createNodeHttp2Transport();
  const sessionStore = injectedStore ?? new CursorSessionStore();
  const modelById = new Map<string, CursorModelDescriptor>(
    context.catalog.language.map((descriptor) => {
      const extra = cursorModelExtra(descriptor.extra);
      return [
        descriptor.id,
        {
          wireModelId: descriptor.id,
          displayModelId: extra.displayModelId ?? descriptor.id,
          displayName: descriptor.displayName ?? descriptor.id,
          maxMode: extra.maxMode ?? false,
        },
      ] as const;
    }),
  );
  const provider = createCursorProviderV4({
    transport,
    credentials: context.credentials,
    sessionStore,
    credentialOptions,
    baseUrl: CURSOR_API_URL,
    modelById,
  });
  return Promise.resolve({ provider });
}

function cursorModelExtra(extra: JsonValue | undefined): {
  readonly displayModelId?: string;
  readonly maxMode?: boolean;
} {
  if (!isPlainObject(extra)) return {};
  const displayModelId = Reflect.get(extra, 'displayModelId');
  const maxMode = Reflect.get(extra, 'maxMode');
  return {
    ...(typeof displayModelId === 'string' && displayModelId.length > 0 ? { displayModelId } : {}),
    ...(typeof maxMode === 'boolean' ? { maxMode } : {}),
  };
}
