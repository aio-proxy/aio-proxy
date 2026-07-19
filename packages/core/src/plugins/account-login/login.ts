import type { AuthorizationPort, ConfigSpec, LocalizedText } from "@aio-proxy/plugin-sdk";
import type { ProviderAlias } from "@aio-proxy/types";
import type { PluginRegistry } from "../registry";
import type { PendingAccountOperation, PluginRepository, StoredAccount } from "../repository/index";
import { validateModelCatalog } from "../catalog";
import { AtomicConfigCommitUncertainError, type AtomicConfigFile, digestProviderEntry } from "../config-file";
import { collectSecretStrings, type DiagnosticFactory, type PluginLogSink, redactPluginError } from "../diagnostic";
import { resolveProviderId } from "../provider-id";
import {
  CATALOG_DISCOVERY_TIMEOUT_MS,
  childDeadline,
  deadlineController,
  loginWithProtectedAuthorization,
  withAbort,
} from "./deadline";
import {
  AccountCleanupPendingError,
  type OAuthCapabilityReference,
  OAuthCapabilityUnavailableError,
  ProviderAccountChangedError,
  ProviderFingerprintMismatchError,
} from "./errors";
import { preflight } from "./login/preflight";
import { safeSupersededDiagnostic } from "./recovery";
import {
  accountMatches,
  capabilityOf,
  duplicateOrCleanup,
  inMemoryCredentialPort,
  type PlainRecord,
  providerEntry,
  providerRecord,
  sameCapability,
  structuredEntry,
  validatedAccountOptions,
  validatedDefaultAliases,
  validatedLoginResult,
  validateStagedOAuthWrite,
} from "./validation";

export type RenderAccountOptionsInput = {
  readonly spec: ConfigSpec<unknown>;
  readonly currentPublicValues: Readonly<Record<string, unknown>>;
  readonly currentSecrets: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
};
export type RenderAccountOptions = (
  input: RenderAccountOptionsInput,
) => Promise<{ readonly publicValues: Record<string, unknown>; readonly secrets: Record<string, unknown> }>;
export type OAuthProviderPatch = {
  readonly name: string | undefined;
  readonly enabled: boolean;
  readonly weight: number | undefined;
  readonly alias: ProviderAlias | undefined;
};
export type LoginOAuthAccountOptions = {
  readonly targetProviderId?: string;
  readonly capability?: OAuthCapabilityReference;
  readonly providerPatch?: OAuthProviderPatch;
  readonly registry: PluginRegistry;
  readonly repository: PluginRepository;
  readonly config: AtomicConfigFile;
  readonly renderAccountOptions: RenderAccountOptions;
  readonly createAuthorization: (signal: AbortSignal) => AuthorizationPort;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly progress?: (message: LocalizedText) => void;
  readonly onAuthorized?: () => void;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
};
export type LoginOAuthAccountResult = { readonly providerId: string };
export async function loginOAuthAccount(options: LoginOAuthAccountOptions): Promise<LoginOAuthAccountResult> {
  const deadline = deadlineController(options.signal);
  try {
    const initial = await preflight(options, deadline.signal);
    const adapter = options.registry.resolveOAuth(initial.capability.plugin, initial.capability.capability);
    if (adapter === undefined)
      throw new OAuthCapabilityUnavailableError(initial.capability.plugin, initial.capability.capability);
    const rendered = await withAbort(deadline.signal, () =>
      options.renderAccountOptions({
        spec: adapter.account.options,
        currentPublicValues: initial.publicOptions,
        currentSecrets: initial.secrets,
        signal: deadline.signal,
      }),
    );
    const parsedOptions = await validatedAccountOptions(adapter, rendered, deadline.signal);
    const loginResult = await loginWithProtectedAuthorization(
      adapter,
      () => options.createAuthorization(deadline.signal),
      options.progress ?? (() => {}),
      deadline.signal,
      parsedOptions.value,
    );
    const validated = await validatedLoginResult(adapter, loginResult, deadline.signal);
    if (initial.fingerprint !== undefined && validated.fingerprint !== initial.fingerprint) {
      throw new ProviderFingerprintMismatchError(options.targetProviderId as string);
    }
    options.onAuthorized?.();
    const metadata: { label?: string; expiresAt?: number } = {
      ...(validated.label === undefined ? {} : { label: validated.label }),
      ...(validated.expiresAt === undefined ? {} : { expiresAt: validated.expiresAt }),
    };
    const discoveryDeadline = childDeadline(deadline.signal, CATALOG_DISCOVERY_TIMEOUT_MS);
    const credentials = inMemoryCredentialPort(adapter, validated.credential, discoveryDeadline.signal, metadata);
    let discovered:
      | { readonly kind: "success"; readonly catalog: ReturnType<typeof validateModelCatalog> }
      | { readonly kind: "failure"; readonly error: unknown };
    try {
      discovered = {
        kind: "success",
        catalog: validateModelCatalog(
          await withAbort(discoveryDeadline.signal, () =>
            adapter.catalog.discover({
              credentials: credentials.port,
              options: parsedOptions.value,
              signal: discoveryDeadline.signal,
            }),
          ),
        ),
      };
    } catch (error) {
      if (deadline.signal.aborted) throw error;
      const fallback = initial.account === undefined ? adapter.catalog.initialFallback?.(error) : undefined;
      discovered =
        fallback === undefined
          ? { kind: "failure", error }
          : { kind: "success", catalog: validateModelCatalog(fallback) };
      if (discovered.kind === "failure") {
        options.logger({
          event: "plugin.catalog.discovery.failed",
          code: "CATALOG_UNAVAILABLE",
          context: { plugin: initial.capability.plugin, capability: initial.capability.capability },
          error: redactPluginError(error, {
            secretValues: [...collectSecretStrings(rendered.secrets), ...collectSecretStrings(credentials.current())],
          }),
        });
      }
    } finally {
      discoveryDeadline.close();
    }
    let staged: PendingAccountOperation | undefined;
    let stagedProviderId: string | undefined;
    try {
      staged = await options.config.transaction(
        async (current) => {
          deadline.signal.throwIfAborted();
          const providers = providerRecord(current);
          const existingFingerprint = options.repository.findAccountByFingerprint(
            initial.capability.plugin,
            initial.capability.capability,
            validated.fingerprint,
          );
          let providerId: string;
          let existingEntry: PlainRecord | undefined;
          let currentAccount: StoredAccount | null = null;
          if (options.targetProviderId === undefined) {
            if (existingFingerprint !== null) {
              const pending = options.repository
                .listPendingAccountOperations()
                .some((operation) => operation.providerId === existingFingerprint.providerId);
              if (pending) throw new AccountCleanupPendingError(existingFingerprint.providerId);
              throw duplicateOrCleanup(existingFingerprint, providers);
            }
            const resolution = resolveProviderId({
              plugin: initial.capability.plugin,
              capability: initial.capability.capability,
              fingerprint: validated.fingerprint,
              suggestedKey: validated.suggestedKey,
              providerIds: Object.keys(providers),
              accounts: options.repository.listAccounts(),
            });
            if (resolution.status === "existing") {
              const existing = options.repository.readAccount(resolution.providerId);
              if (existing === null) throw new AccountCleanupPendingError(resolution.providerId);
              if (
                options.repository
                  .listPendingAccountOperations()
                  .some((operation) => operation.providerId === resolution.providerId)
              )
                throw new AccountCleanupPendingError(resolution.providerId);
              throw duplicateOrCleanup(existing, providers);
            }
            providerId = resolution.providerId;
          } else {
            providerId = options.targetProviderId;
            existingEntry = structuredEntry(providers[providerId]) ?? undefined;
            currentAccount = options.repository.readAccount(providerId);
            const pending = options.repository
              .listPendingAccountOperations()
              .find((operation) => operation.providerId === providerId);
            if (
              existingEntry === undefined ||
              currentAccount === null ||
              pending !== undefined ||
              initial.runtimeRevision !== currentAccount.runtimeRevision ||
              initial.fingerprint !== currentAccount.fingerprint ||
              !accountMatches(currentAccount, initial.capability) ||
              !sameCapability(capabilityOf(existingEntry), initial.capability)
            )
              throw new ProviderAccountChangedError(providerId);
            if (validated.fingerprint !== currentAccount.fingerprint)
              throw new ProviderFingerprintMismatchError(providerId);
          }
          const defaults =
            currentAccount === null && discovered.kind === "success"
              ? validatedDefaultAliases(adapter, discovered.catalog)
              : undefined;
          const entry = providerEntry(
            initial.capability.plugin,
            initial.capability.capability,
            rendered.publicValues,
            existingEntry,
            defaults,
            options.providerPatch,
          );
          const targetDigest = digestProviderEntry(entry);
          const catalogDiagnostic = options.diagnostics("CATALOG_UNAVAILABLE", {
            plugin: initial.capability.plugin,
            capability: initial.capability.capability,
            providerId,
            retryable: true,
          });
          const account = {
            providerId,
            plugin: initial.capability.plugin,
            capability: initial.capability.capability,
            fingerprint: validated.fingerprint,
            options: rendered.publicValues,
            secrets: rendered.secrets,
            credential: credentials.current(),
            ...(metadata.label === undefined ? {} : { label: metadata.label }),
            ...(metadata.expiresAt === undefined ? {} : { expiresAt: metadata.expiresAt }),
            catalog:
              discovered.kind === "success"
                ? ({
                    kind: "replace",
                    value: { catalog: discovered.catalog, refreshedAt: (options.now ?? Date.now)() },
                  } as const)
                : currentAccount === null
                  ? ({ kind: "missing", diagnostic: catalogDiagnostic } as const)
                  : ({ kind: "preserve", diagnostic: catalogDiagnostic } as const),
          };
          deadline.signal.throwIfAborted();
          const operation =
            currentAccount === null
              ? options.repository.stageAccountOperation({ kind: "create", targetDigest, account })
              : options.repository.stageAccountOperation({
                  kind: "update",
                  targetDigest,
                  expectedRuntimeRevision: initial.runtimeRevision as number,
                  account,
                });
          staged = operation;
          stagedProviderId = providerId;
          return { next: { ...current, providers: { ...providers, [providerId]: entry } }, result: operation };
        },
        { validateCandidate: validateStagedOAuthWrite, signal: deadline.signal },
      );
    } catch (error) {
      if (staged !== undefined && !(error instanceof AtomicConfigCommitUncertainError)) {
        const status = options.repository.compensateAccountOperation(staged.operationId);
        if (status === "superseded" && stagedProviderId !== undefined)
          safeSupersededDiagnostic(stagedProviderId, options.repository, options.diagnostics, options.logger);
      }
      throw error;
    }
    options.repository.completeAccountOperation(staged.operationId);
    return { providerId: staged.providerId };
  } finally {
    deadline.close();
  }
}
