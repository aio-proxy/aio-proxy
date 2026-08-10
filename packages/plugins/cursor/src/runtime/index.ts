import type { OAuthRuntimeResult, RuntimeContext } from '@aio-proxy/plugin-sdk';

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
    context.catalog.language.map((descriptor) => [
      descriptor.id,
      {
        wireModelId: descriptor.id,
        displayModelId: descriptor.id,
        displayName: descriptor.displayName ?? descriptor.id,
        maxMode: false,
      },
    ]),
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

export { createCursorProviderV4, type CursorModelDescriptor, type CursorProviderRuntime } from './provider/index';
export { createCursorLanguageModel, type CursorModelRuntime } from './cursor-model/index';
export { runCursorTurn, type CursorTurnResult } from './driver/index';
