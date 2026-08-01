import type { ProviderV4 } from '@ai-sdk/provider';
import type { CredentialPort } from '@aio-proxy/plugin-sdk';

import type { CursorOAuthDependencies } from '../oauth';
import type { CursorCredential } from '../schema';
import type { CursorSessionStore } from '../store/session-store';
import type { CursorTransport } from '../wire/transport';
import { createCursorLanguageModel } from './cursor-model';

export type CursorModelDescriptor = {
  readonly wireModelId: string;
  readonly displayModelId: string;
  readonly displayName: string;
  readonly maxMode: boolean;
};

export type CursorProviderRuntime = {
  readonly transport: CursorTransport;
  readonly credentials: CredentialPort<CursorCredential>;
  readonly sessionStore: CursorSessionStore;
  readonly credentialOptions?: CursorOAuthDependencies;
  readonly baseUrl?: string;
  readonly modelById: ReadonlyMap<string, CursorModelDescriptor>;
};

export function createCursorProviderV4(runtime: CursorProviderRuntime): ProviderV4 {
  return {
    specificationVersion: 'v4',
    languageModel: (modelId: string) => {
      const model = runtime.modelById.get(modelId);
      if (model === undefined) throw new Error(`Cursor OAuth has no model "${modelId}" in the discovered catalog`);
      return createCursorLanguageModel(modelId, {
        transport: runtime.transport,
        credentials: runtime.credentials,
        sessionStore: runtime.sessionStore,
        ...(runtime.credentialOptions === undefined ? {} : { credentialOptions: runtime.credentialOptions }),
        ...(runtime.baseUrl === undefined ? {} : { baseUrl: runtime.baseUrl }),
        model,
      });
    },
    embeddingModel: unsupported('embedding'),
    imageModel: unsupported('image generation'),
  };
}

function unsupported(kind: string): (modelId: string) => never {
  return (modelId) => {
    throw new Error(`Cursor OAuth does not support ${kind} model ${modelId}`);
  };
}
