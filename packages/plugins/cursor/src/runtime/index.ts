import type { OAuthRuntimeResult, RuntimeContext } from '@aio-proxy/plugin-sdk';

import type { CursorOAuthDependencies } from '../oauth';
import type { CursorCredential } from '../schema';
import { CursorSessionStore } from '../store/session-store';
import { CURSOR_API_URL, createNodeHttp2Transport, type CursorTransport } from '../wire/transport';
import { createCursorProviderV4, type CursorModelDescriptor } from './provider';

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
  const { transport: injectedTransport, sessionStore: injectedStore, ...credentialOptions } = dependencies;
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
    ...(Object.keys(credentialOptions).length === 0 ? {} : { credentialOptions }),
    baseUrl: CURSOR_API_URL,
    modelById,
  });
  return Promise.resolve({ provider });
}

export { createCursorProviderV4, type CursorModelDescriptor, type CursorProviderRuntime } from './provider';
export { createCursorLanguageModel, type CursorModelRuntime } from './cursor-model';
export { runCursorTurn, type CursorTurnResult } from './driver';
