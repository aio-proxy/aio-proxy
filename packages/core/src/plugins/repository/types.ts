import type { ModelCatalog } from "@aio-proxy/plugin-sdk";
import type { Diagnostic, DiagnosticCode } from "@aio-proxy/types";

export type PluginSecretSnapshot = { readonly value: unknown; readonly revision: number };

export type StoredAccount = {
  readonly providerId: string;
  readonly plugin: string;
  readonly capability: string;
  readonly fingerprint: string;
  readonly options: unknown;
  readonly secrets: unknown;
  readonly credential: unknown;
  readonly revision: number;
  readonly runtimeRevision: number;
  readonly label?: string;
  readonly expiresAt?: number;
  readonly updatedAt: number;
};

export type StoredAccountSummary = Omit<StoredAccount, "options" | "secrets" | "credential">;
export type StoredCatalog = { readonly catalog: ModelCatalog; readonly refreshedAt: number };

export type PendingAccountOperation = {
  readonly operationId: string;
  readonly providerId: string;
  readonly kind: "create" | "update" | "delete";
  readonly targetDigest: string;
  readonly appliedRevision: number;
  readonly previousRevision?: number;
  readonly createdAt: number;
};

export type AccountWrite = {
  readonly providerId: string;
  readonly plugin: string;
  readonly capability: string;
  readonly fingerprint: string;
  readonly options: unknown;
  readonly secrets: unknown;
  readonly credential: unknown;
  readonly label?: string;
  readonly expiresAt?: number;
  readonly catalog:
    | { readonly kind: "replace"; readonly value: StoredCatalog }
    | { readonly kind: "preserve"; readonly diagnostic: Diagnostic }
    | { readonly kind: "missing"; readonly diagnostic: Diagnostic };
};

export type StageAccountOperationInput =
  | { readonly kind: "create"; readonly targetDigest: string; readonly account: AccountWrite }
  | {
      readonly kind: "update";
      readonly targetDigest: string;
      readonly expectedRuntimeRevision: number;
      readonly account: AccountWrite;
    }
  | {
      readonly kind: "delete";
      readonly targetDigest: "absent";
      readonly providerId: string;
      readonly expectedRuntimeRevision: number;
    };

export class PendingAccountOperationConflictError extends Error {
  override readonly name = "PendingAccountOperationConflictError";
  constructor(
    readonly providerId: string,
    readonly pendingKind: PendingAccountOperation["kind"],
  ) {
    super("PENDING_ACCOUNT_OPERATION_CONFLICT");
  }
}

export type PluginRepository = {
  readonly readPluginSecret: (plugin: string) => PluginSecretSnapshot | null;
  readonly writePluginSecret: (plugin: string, expectedRevision: number | null, value: unknown) => PluginSecretSnapshot;
  readonly deletePluginSecret: (plugin: string, expectedRevision: number) => boolean;
  readonly readAccount: (providerId: string) => StoredAccount | null;
  readonly findAccountByFingerprint: (plugin: string, capability: string, fingerprint: string) => StoredAccount | null;
  readonly listAccounts: () => readonly StoredAccountSummary[];
  readonly readCatalog: (providerId: string) => StoredCatalog | null;
  readonly writeCatalog: (providerId: string, catalog: ModelCatalog, refreshedAt: number) => void;
  readonly readDiagnostics: (providerId: string) => readonly Diagnostic[];
  readonly writeDiagnostic: (providerId: string, diagnostic: Diagnostic) => boolean;
  readonly clearDiagnostic: (providerId: string, code: DiagnosticCode) => boolean;
  readonly deleteAccount: (providerId: string) => void;
  readonly stageAccountOperation: (input: StageAccountOperationInput) => PendingAccountOperation;
  readonly completeAccountOperation: (operationId: string) => void;
  readonly compensateAccountOperation: (operationId: string) => "compensated" | "superseded";
  readonly finalizeDeleteOperation: (operationId: string) => "deleted" | "superseded";
  readonly listPendingAccountOperations: () => readonly PendingAccountOperation[];
  readonly tryAcquireRefreshLease: (providerId: string, owner: string, now: number, expiresAt: number) => boolean;
  readonly renewRefreshLease: (providerId: string, owner: string, expiresAt: number) => boolean;
  readonly releaseRefreshLease: (providerId: string, owner: string) => void;
  readonly compareAndSwapCredential: (
    providerId: string,
    expectedRevision: number,
    leaseOwner: string,
    credential: unknown,
    metadata?: { readonly label?: string; readonly expiresAt?: number },
  ) => StoredAccount | null;
};
