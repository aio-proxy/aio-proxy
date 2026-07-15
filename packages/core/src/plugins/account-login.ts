import type {
  AuthorizationPort,
  ConfigSpec,
  CredentialPort,
  OAuthAdapter,
  OAuthLoginResult,
} from "@aio-proxy/plugin-sdk";
import { ConfigSchema, OAuthPluginProviderSchema } from "@aio-proxy/types";
import { validateModelCatalog } from "./catalog";
import { AtomicConfigCommitUncertainError, type AtomicConfigFile, digestProviderEntry } from "./config-file";
import type { DiagnosticFactory, PluginLogSink } from "./diagnostic";
import { redactPluginError } from "./diagnostic";
import { resolveProviderId } from "./provider-id";
import type { PluginRegistry } from "./registry";
import type { PendingAccountOperation, PluginRepository, StoredAccount } from "./repository";
import { parsePluginSchema } from "./schema";

type ConfigRecord = Record<string, unknown>;
type PlainRecord = Record<string, unknown>;

export const LOGIN_TIMEOUT_MS = 20 * 60_000;
export const CATALOG_DISCOVERY_TIMEOUT_MS = 30_000;
export const PENDING_OPERATION_TTL_MS = 30 * 60_000;
export const ORPHAN_ACCOUNT_GRACE_MS = 30 * 60_000;
export const RECOVERY_DRAIN_RETRY_MS = 5_000;
export const ABSENT_PROVIDER_DIGEST = "absent";

export type OAuthCapabilityReference = { readonly plugin: string; readonly capability: string };

export type RenderAccountOptionsInput = {
  readonly spec: ConfigSpec<unknown>;
  readonly currentPublicValues: Readonly<Record<string, unknown>>;
  readonly currentSecrets: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
};

export type RenderAccountOptions = (
  input: RenderAccountOptionsInput,
) => Promise<{ readonly publicValues: Record<string, unknown>; readonly secrets: Record<string, unknown> }>;

export type LoginOAuthAccountOptions = {
  readonly targetProviderId?: string;
  readonly capability?: OAuthCapabilityReference;
  readonly registry: PluginRegistry;
  readonly repository: PluginRepository;
  readonly config: AtomicConfigFile;
  readonly renderAccountOptions: RenderAccountOptions;
  readonly createAuthorization: (signal: AbortSignal) => AuthorizationPort;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly progress?: (message: string) => void;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
};

export type LoginOAuthAccountResult = { readonly providerId: string };

export type DeleteOAuthAccountOptions = {
  readonly providerId: string;
  readonly config: AtomicConfigFile;
  readonly repository: PluginRepository;
};

export type RecoverPendingAccountOperationsOptions =
  | { readonly mode: "cli"; readonly now?: () => number }
  | {
      readonly mode: "server";
      readonly canDeleteAccount: (providerId: string) => boolean;
      readonly now?: () => number;
    };

export class ProviderAccountAlreadyExistsError extends Error {
  override readonly name = "ProviderAccountAlreadyExistsError";
  readonly suggestedCommand: string;

  constructor(readonly existingProviderId: string) {
    super("PROVIDER_ACCOUNT_ALREADY_EXISTS");
    this.suggestedCommand = `aio-proxy provider login --provider ${existingProviderId}`;
  }
}

export class AccountCleanupPendingError extends Error {
  override readonly name = "AccountCleanupPendingError";

  constructor(readonly providerId: string) {
    super("ACCOUNT_CLEANUP_PENDING");
  }
}

export class ProviderAccountChangedError extends Error {
  override readonly name = "ProviderAccountChangedError";

  constructor(readonly providerId: string) {
    super("PROVIDER_ACCOUNT_CHANGED");
  }
}

export class ProviderFingerprintMismatchError extends Error {
  override readonly name = "ProviderFingerprintMismatchError";

  constructor(readonly providerId: string) {
    super("PROVIDER_FINGERPRINT_MISMATCH");
  }
}

export class ProviderCapabilityTargetMismatchError extends Error {
  override readonly name = "ProviderCapabilityTargetMismatchError";

  constructor(
    readonly requested: OAuthCapabilityReference,
    readonly target: OAuthCapabilityReference,
  ) {
    super("PROVIDER_CAPABILITY_TARGET_MISMATCH");
  }
}

export class OAuthLoginResultValidationError extends Error {
  override readonly name = "OAuthLoginResultValidationError";

  constructor() {
    super("OAUTH_LOGIN_RESULT_INVALID");
  }
}

export class AccountOptionsValidationError extends Error {
  override readonly name = "AccountOptionsValidationError";

  constructor() {
    super("ACCOUNT_OPTIONS_INVALID");
  }
}

export class OAuthLoginTimeoutError extends Error {
  override readonly name = "OAuthLoginTimeoutError";

  constructor() {
    super("OAUTH_LOGIN_TIMEOUT");
  }
}

export class OAuthCatalogDiscoveryTimeoutError extends Error {
  override readonly name = "OAuthCatalogDiscoveryTimeoutError";

  constructor() {
    super("OAUTH_CATALOG_DISCOVERY_TIMEOUT");
  }
}

export class OAuthCapabilityRequiredError extends Error {
  override readonly name = "OAuthCapabilityRequiredError";

  constructor() {
    super("OAUTH_CAPABILITY_REQUIRED");
  }
}

export class OAuthCapabilityUnavailableError extends Error {
  override readonly name = "OAuthCapabilityUnavailableError";

  constructor(
    readonly plugin: string,
    readonly capability: string,
  ) {
    super("OAUTH_CAPABILITY_UNAVAILABLE");
  }
}

export class ProviderConfigInvalidError extends Error {
  override readonly name = "ProviderConfigInvalidError";

  constructor() {
    super("PROVIDER_CONFIG_INVALID");
  }
}

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerRecord(current: ConfigRecord): Record<string, unknown> {
  const providers = current["providers"];
  if (providers === undefined) return {};
  if (isRecord(providers)) return providers;
  ConfigSchema.parse(current);
  throw new ProviderConfigInvalidError();
}

function structuredEntry(value: unknown): PlainRecord | null {
  if (!isRecord(value) || value["kind"] !== "oauth" || Object.hasOwn(value, "vendor")) return null;
  const parsed = OAuthPluginProviderSchema.safeParse({ ...value, id: "staged" });
  return parsed.success ? value : null;
}

function capabilityOf(entry: PlainRecord): OAuthCapabilityReference {
  return { plugin: entry["plugin"] as string, capability: entry["capability"] as string };
}

function sameCapability(left: OAuthCapabilityReference, right: OAuthCapabilityReference): boolean {
  return left.plugin === right.plugin && left.capability === right.capability;
}

function accountMatches(account: StoredAccount, capability: OAuthCapabilityReference): boolean {
  return account.plugin === capability.plugin && account.capability === capability.capability;
}

function validateStagedOAuthWrite(candidate: ConfigRecord): void {
  const providers = candidate["providers"];
  if (!isRecord(providers)) {
    ConfigSchema.parse(candidate);
    return;
  }
  const legacyProviders: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(providers)) {
    if (isRecord(value) && value["kind"] === "oauth" && !Object.hasOwn(value, "vendor")) {
      OAuthPluginProviderSchema.parse({ ...value, id });
    } else {
      legacyProviders[id] = value;
    }
  }
  ConfigSchema.parse({ ...candidate, providers: legacyProviders });
}

function deadlineController(parent?: AbortSignal): { readonly signal: AbortSignal; readonly close: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new OAuthLoginTimeoutError()), LOGIN_TIMEOUT_MS);
  timeout.unref?.();
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function childDeadline(
  parent: AbortSignal,
  milliseconds: number,
): { readonly signal: AbortSignal; readonly close: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new OAuthCatalogDiscoveryTimeoutError()), milliseconds);
  timeout.unref?.();
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timeout);
      parent.removeEventListener("abort", abort);
    },
  };
}

async function withAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let rejectAbort = (_reason: unknown) => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([Promise.resolve().then(operation), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function stringLeaves(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return value.length === 0 ? [] : [value];
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);
  try {
    return Object.values(value).flatMap((item) => stringLeaves(item, seen));
  } catch {
    return [];
  } finally {
    seen.delete(value);
  }
}

async function validatedLoginResult<Credential>(
  adapter: OAuthAdapter<unknown, Credential>,
  raw: OAuthLoginResult<Credential>,
  signal: AbortSignal,
): Promise<{
  readonly fingerprint: string;
  readonly suggestedKey: string;
  readonly label?: string;
  readonly expiresAt?: number;
  readonly credential: Credential;
}> {
  if (!isRecord(raw)) throw new OAuthLoginResultValidationError();
  const { fingerprint, suggestedKey, label, expiresAt, credentials } = raw;
  if (
    typeof fingerprint !== "string" ||
    fingerprint.trim().length === 0 ||
    typeof suggestedKey !== "string" ||
    (label !== undefined && typeof label !== "string") ||
    (expiresAt !== undefined &&
      (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || !Number.isInteger(expiresAt)))
  ) {
    throw new OAuthLoginResultValidationError();
  }
  const parsed = await withAbort(signal, () => parsePluginSchema(adapter.credentials, credentials));
  if (!parsed.ok) throw new OAuthLoginResultValidationError();
  return {
    fingerprint: fingerprint.trim(),
    suggestedKey,
    ...(label === undefined ? {} : { label }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    credential: parsed.value,
  };
}

function inMemoryCredentialPort<Credential>(
  adapter: OAuthAdapter<unknown, Credential>,
  initial: Credential,
  signal: AbortSignal,
  metadata: { label?: string; expiresAt?: number },
): { readonly port: CredentialPort<Credential>; readonly current: () => Credential } {
  let value = initial;
  let revision = 0;
  type RefreshResult = Awaited<ReturnType<CredentialPort<Credential>["refresh"]>>;
  let refreshFlight: Promise<RefreshResult> | undefined;
  return {
    port: {
      async read() {
        return { value, revision };
      },
      refresh(expectedRevision, exchange) {
        if (refreshFlight !== undefined) return refreshFlight;
        const flight = (async (): Promise<RefreshResult> => {
          if (expectedRevision !== revision) return { status: "superseded", snapshot: { value, revision } };
          const exchanged = await exchange({ value, revision }, signal);
          const parsed = await withAbort(signal, () => parsePluginSchema(adapter.credentials, exchanged.value));
          if (!parsed.ok) throw new OAuthLoginResultValidationError();
          if (exchanged.metadata?.label !== undefined) metadata.label = exchanged.metadata.label;
          if (exchanged.metadata?.expiresAt !== undefined) {
            if (!Number.isFinite(exchanged.metadata.expiresAt) || !Number.isInteger(exchanged.metadata.expiresAt)) {
              throw new OAuthLoginResultValidationError();
            }
            metadata.expiresAt = exchanged.metadata.expiresAt;
          }
          value = parsed.value;
          revision += 1;
          return { status: "updated", snapshot: { value, revision } };
        })();
        refreshFlight = flight;
        const cleanup = () => {
          if (refreshFlight === flight) refreshFlight = undefined;
        };
        void flight.then(cleanup, cleanup);
        return flight;
      },
    },
    current: () => value,
  };
}

type Preflight = {
  readonly capability: OAuthCapabilityReference;
  readonly account?: StoredAccount;
  readonly runtimeRevision?: number;
  readonly fingerprint?: string;
  readonly publicOptions: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, unknown>>;
};

async function preflight(options: LoginOAuthAccountOptions, signal: AbortSignal): Promise<Preflight> {
  signal.throwIfAborted();
  if (options.targetProviderId === undefined) {
    if (options.capability === undefined) throw new OAuthCapabilityRequiredError();
    return { capability: options.capability, publicOptions: {}, secrets: {} };
  }
  return options.config.transaction(
    async (current) => {
      signal.throwIfAborted();
      const entry = structuredEntry(providerRecord(current)[options.targetProviderId as string]);
      const account = options.repository.readAccount(options.targetProviderId as string);
      if (entry === null || account === null) throw new AccountCleanupPendingError(options.targetProviderId as string);
      const targetCapability = capabilityOf(entry);
      if (!accountMatches(account, targetCapability))
        throw new AccountCleanupPendingError(options.targetProviderId as string);
      if (options.capability !== undefined && !sameCapability(options.capability, targetCapability)) {
        throw new ProviderCapabilityTargetMismatchError(options.capability, targetCapability);
      }
      const pendingDelete = options.repository
        .listPendingAccountOperations()
        .find((operation) => operation.providerId === options.targetProviderId && operation.kind === "delete");
      signal.throwIfAborted();
      if (pendingDelete !== undefined) options.repository.completeAccountOperation(pendingDelete.operationId);
      return {
        next: current,
        result: {
          capability: targetCapability,
          account,
          runtimeRevision: account.runtimeRevision,
          fingerprint: account.fingerprint,
          publicOptions: isRecord(entry["options"]) ? entry["options"] : {},
          secrets: isRecord(account.secrets) ? account.secrets : {},
        },
      };
    },
    { signal },
  );
}

function providerEntry(
  plugin: string,
  capability: string,
  publicOptions: Record<string, unknown>,
  existing?: PlainRecord,
): PlainRecord {
  return {
    kind: "oauth",
    plugin,
    capability,
    ...(Object.keys(publicOptions).length === 0 ? {} : { options: publicOptions }),
    enabled: existing?.["enabled"] ?? true,
    ...(existing?.["weight"] === undefined ? {} : { weight: existing["weight"] }),
    ...(existing?.["name"] === undefined ? {} : { name: existing["name"] }),
    ...(existing?.["alias"] === undefined ? {} : { alias: existing["alias"] }),
  };
}

function duplicateOrCleanup(
  account: StoredAccount,
  providers: Record<string, unknown>,
): ProviderAccountAlreadyExistsError | AccountCleanupPendingError {
  const entry = structuredEntry(providers[account.providerId]);
  return entry !== null && accountMatches(account, capabilityOf(entry))
    ? new ProviderAccountAlreadyExistsError(account.providerId)
    : new AccountCleanupPendingError(account.providerId);
}

function safeSupersededDiagnostic(
  providerId: string,
  repository: PluginRepository,
  diagnostics?: DiagnosticFactory,
  logger?: PluginLogSink,
  now = Date.now(),
): void {
  if (repository.readAccount(providerId) === null) return;
  const suggestedCommand = `aio-proxy provider login --provider ${providerId}`;
  const diagnostic = diagnostics?.("AUTHORIZATION_FAILED", {
    providerId,
    retryable: true,
    suggestedCommand,
  }) ?? {
    code: "AUTHORIZATION_FAILED" as const,
    summary: "ACCOUNT_OPERATION_SUPERSEDED",
    retryable: true,
    occurredAt: new Date(now).toISOString(),
    suggestedCommand,
  };
  repository.writeDiagnostic(providerId, diagnostic);
  logger?.({
    event: "plugin.account.compensation.superseded",
    code: "AUTHORIZATION_FAILED",
    context: { providerId },
    error: { name: "Error", message: "ACCOUNT_OPERATION_SUPERSEDED" },
  });
}

export async function loginOAuthAccount(options: LoginOAuthAccountOptions): Promise<LoginOAuthAccountResult> {
  const deadline = deadlineController(options.signal);
  try {
    const initial = await preflight(options, deadline.signal);
    const adapter = options.registry.resolveOAuth(initial.capability.plugin, initial.capability.capability);
    if (adapter === undefined) {
      throw new OAuthCapabilityUnavailableError(initial.capability.plugin, initial.capability.capability);
    }
    const rendered = await withAbort(deadline.signal, () =>
      options.renderAccountOptions({
        spec: adapter.account.options,
        currentPublicValues: initial.publicOptions,
        currentSecrets: initial.secrets,
        signal: deadline.signal,
      }),
    );
    if (!isRecord(rendered.publicValues) || !isRecord(rendered.secrets)) throw new AccountOptionsValidationError();
    const merged = { ...rendered.publicValues, ...rendered.secrets };
    const parsedOptions = await withAbort(deadline.signal, () =>
      parsePluginSchema(adapter.account.options.schema, merged),
    );
    if (!parsedOptions.ok) throw new AccountOptionsValidationError();
    const authorization = options.createAuthorization(deadline.signal);
    const loginResult = await withAbort(deadline.signal, () =>
      adapter.login(
        { authorization, progress: options.progress ?? (() => {}), signal: deadline.signal },
        parsedOptions.value,
      ),
    );
    const validated = await validatedLoginResult(adapter, loginResult, deadline.signal);
    if (initial.fingerprint !== undefined && validated.fingerprint !== initial.fingerprint) {
      throw new ProviderFingerprintMismatchError(options.targetProviderId as string);
    }

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
      discovered = { kind: "failure", error };
      options.logger({
        event: "plugin.catalog.discovery.failed",
        code: "CATALOG_UNAVAILABLE",
        context: { plugin: initial.capability.plugin, capability: initial.capability.capability },
        error: redactPluginError(error, {
          secretValues: [...stringLeaves(rendered.secrets), ...stringLeaves(credentials.current())],
        }),
      });
    } finally {
      discoveryDeadline.close();
    }

    let staged: PendingAccountOperation | undefined;
    let stagedProviderId: string | undefined;
    try {
      const committedOperation = await options.config.transaction(
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
              const pending = options.repository
                .listPendingAccountOperations()
                .some((operation) => operation.providerId === resolution.providerId);
              if (pending) throw new AccountCleanupPendingError(resolution.providerId);
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
            ) {
              throw new ProviderAccountChangedError(providerId);
            }
            if (validated.fingerprint !== currentAccount.fingerprint)
              throw new ProviderFingerprintMismatchError(providerId);
          }
          const entry = providerEntry(
            initial.capability.plugin,
            initial.capability.capability,
            rendered.publicValues,
            existingEntry,
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
      staged = committedOperation;
    } catch (error) {
      if (staged !== undefined && !(error instanceof AtomicConfigCommitUncertainError)) {
        const status = options.repository.compensateAccountOperation(staged.operationId);
        if (status === "superseded" && stagedProviderId !== undefined) {
          safeSupersededDiagnostic(stagedProviderId, options.repository, options.diagnostics, options.logger);
        }
      }
      throw error;
    }
    options.repository.completeAccountOperation(staged.operationId);
    return { providerId: staged.providerId };
  } finally {
    deadline.close();
  }
}

export async function deleteOAuthAccount(options: DeleteOAuthAccountOptions): Promise<PendingAccountOperation> {
  let staged: PendingAccountOperation | undefined;
  try {
    const committedOperation = await options.config.transaction(
      async (current) => {
        const providers = providerRecord(current);
        const entry = structuredEntry(providers[options.providerId]);
        const account = options.repository.readAccount(options.providerId);
        if (entry === null || account === null || !accountMatches(account, capabilityOf(entry))) {
          throw new AccountCleanupPendingError(options.providerId);
        }
        const operation = options.repository.stageAccountOperation({
          kind: "delete",
          targetDigest: ABSENT_PROVIDER_DIGEST,
          providerId: options.providerId,
          expectedRuntimeRevision: account.runtimeRevision,
        });
        staged = operation;
        const { [options.providerId]: _removed, ...remaining } = providers;
        return { next: { ...current, providers: remaining }, result: operation };
      },
      { validateCandidate: validateStagedOAuthWrite },
    );
    staged = committedOperation;
    return staged;
  } catch (error) {
    if (staged !== undefined && !(error instanceof AtomicConfigCommitUncertainError)) {
      options.repository.compensateAccountOperation(staged.operationId);
    }
    throw error;
  }
}

function earlier(current: number | undefined, candidate: number): number {
  return current === undefined ? candidate : Math.min(current, candidate);
}

export async function recoverPendingAccountOperations(
  config: AtomicConfigFile,
  repository: PluginRepository,
  options: RecoverPendingAccountOperationsOptions,
  diagnostics?: { readonly factory: DiagnosticFactory; readonly logger: PluginLogSink },
): Promise<{ readonly nextRunAt?: number }> {
  const now = (options.now ?? Date.now)();
  let nextRunAt: number | undefined;
  await config.transaction(async (current) => {
    const rawProviders = current["providers"];
    if (rawProviders !== undefined && !isRecord(rawProviders)) {
      ConfigSchema.safeParse(current);
      nextRunAt = earlier(nextRunAt, now + RECOVERY_DRAIN_RETRY_MS);
      return { next: current, result: undefined };
    }
    const providers = rawProviders ?? {};
    for (const operation of repository.listPendingAccountOperations()) {
      const deadline = operation.createdAt + PENDING_OPERATION_TTL_MS;
      if (now < deadline) {
        nextRunAt = earlier(nextRunAt, deadline);
        continue;
      }
      if (options.mode === "cli" && operation.kind === "delete") continue;
      const currentEntry = providers[operation.providerId];
      const observedDigest = currentEntry === undefined ? ABSENT_PROVIDER_DIGEST : digestProviderEntry(currentEntry);
      if (observedDigest === operation.targetDigest) {
        if (operation.kind === "delete") {
          if (options.mode !== "server") continue;
          if (!options.canDeleteAccount(operation.providerId)) {
            nextRunAt = earlier(nextRunAt, now + RECOVERY_DRAIN_RETRY_MS);
            continue;
          }
          repository.finalizeDeleteOperation(operation.operationId);
        } else {
          repository.completeAccountOperation(operation.operationId);
        }
      } else if (operation.kind === "delete") {
        repository.completeAccountOperation(operation.operationId);
      } else {
        const status = repository.compensateAccountOperation(operation.operationId);
        if (status === "superseded") {
          safeSupersededDiagnostic(operation.providerId, repository, diagnostics?.factory, diagnostics?.logger, now);
        }
      }
    }

    const pendingProviderIds = new Set(
      repository.listPendingAccountOperations().map((operation) => operation.providerId),
    );
    for (const account of repository.listAccounts()) {
      if (Object.hasOwn(providers, account.providerId) || pendingProviderIds.has(account.providerId)) continue;
      const graceDeadline = account.updatedAt + ORPHAN_ACCOUNT_GRACE_MS;
      if (now < graceDeadline) {
        nextRunAt = earlier(nextRunAt, graceDeadline);
        continue;
      }
      if (options.mode !== "server") continue;
      if (!options.canDeleteAccount(account.providerId)) {
        nextRunAt = earlier(nextRunAt, now + RECOVERY_DRAIN_RETRY_MS);
        continue;
      }
      repository.deleteAccount(account.providerId);
    }
    return { next: current, result: undefined };
  });
  return nextRunAt === undefined ? {} : { nextRunAt };
}
