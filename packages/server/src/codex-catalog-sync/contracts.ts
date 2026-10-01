export type CodexCatalog = { readonly models: readonly Record<string, unknown>[] };
export type CodexInstructionsMode = 'compact' | 'full';
export type CodexCatalogSyncReason = 'startup' | 'models-changed' | 'request' | 'periodic';
export type CodexCatalogSource = { readonly load: (signal: AbortSignal) => Promise<CodexCatalog> };
export type CodexCatalogSync = {
  readonly schedule: (reason: CodexCatalogSyncReason) => void;
  readonly close: () => void;
};
export type CodexCatalogSyncFactory = (source: CodexCatalogSource) => CodexCatalogSync;
