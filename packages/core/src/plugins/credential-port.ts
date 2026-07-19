import {
  type CredentialPort,
  CredentialRefreshError,
  type CredentialSnapshot,
  type ZodType,
} from "@aio-proxy/plugin-sdk";
import { providerLoginCommand } from "@aio-proxy/types";
import { delay } from "es-toolkit/promise";

import type { PluginRepository, StoredAccount } from "./repository/index";

import { collectSecretStrings, type DiagnosticFactory, type PluginLogSink, redactPluginError } from "./diagnostic";
import { parsePluginSchema } from "./schema";

const REFRESH_LEASE_MS = 45_000;
const REFRESH_RENEW_MS = 15_000;
const REFRESH_EXCHANGE_TIMEOUT_MS = 30_000;
const REFRESH_WAIT_TIMEOUT_MS = 60_000;
const REFRESH_POLL_MS = 100;
const REFRESH_POLL_JITTER_MS = 25;

type RefreshResult<Credential> = Awaited<ReturnType<CredentialPort<Credential>["refresh"]>>;

export type CredentialPortMode = "runtime" | "control-plane";

type CredentialPortBaseOptions<Credential> = {
  readonly providerId: string;
  readonly schema: ZodType<Credential>;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly onDiagnosticChanged: () => void;
  readonly onCredentialChanged: () => void;
};

export type CreateCredentialPortOptions<Credential> = CredentialPortBaseOptions<Credential> &
  (
    | {
        readonly mode?: "runtime";
        readonly pluginSecrets?: unknown;
        readonly additionalSecretValues?: never;
      }
    | {
        readonly mode: "control-plane";
        readonly pluginSecrets?: never;
        readonly additionalSecretValues?: readonly string[];
      }
  );

export class CredentialValidationError extends Error {
  readonly issues: readonly { readonly message: string; readonly path: readonly (string | number)[] }[];

  constructor(issues: readonly { readonly message: string; readonly path: readonly (string | number)[] }[]) {
    super("Credential validation failed");
    this.name = "CredentialValidationError";
    this.issues = issues;
  }
}

export class CredentialRefreshTimeoutError extends Error {
  constructor() {
    super("Credential refresh exchange timed out");
    this.name = "CredentialRefreshTimeoutError";
  }
}

export class CredentialRefreshWaitTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for the credential refresh lease");
    this.name = "CredentialRefreshWaitTimeoutError";
  }
}

export class CredentialRefreshLeaseLostError extends Error {
  constructor() {
    super("Credential refresh lease was lost");
    this.name = "CredentialRefreshLeaseLostError";
  }
}

export class CredentialAccountMissingError extends Error {
  constructor() {
    super("Credential account is unavailable");
    this.name = "CredentialAccountMissingError";
  }
}

const refreshFlights = new WeakMap<
  PluginRepository,
  Map<string, Map<CredentialPortMode, Promise<RefreshResult<unknown>>>>
>();

function singleFlight<Credential>(
  repository: PluginRepository,
  providerId: string,
  mode: CredentialPortMode,
  run: () => Promise<RefreshResult<Credential>>,
): Promise<RefreshResult<Credential>> {
  const repositoryFlights =
    refreshFlights.get(repository) ?? new Map<string, Map<CredentialPortMode, Promise<RefreshResult<unknown>>>>();
  const providerFlights =
    repositoryFlights.get(providerId) ?? new Map<CredentialPortMode, Promise<RefreshResult<unknown>>>();
  const existing = providerFlights.get(mode);
  if (existing !== undefined) return existing as Promise<RefreshResult<Credential>>;
  const flight = run();
  providerFlights.set(mode, flight as Promise<RefreshResult<unknown>>);
  repositoryFlights.set(providerId, providerFlights);
  refreshFlights.set(repository, repositoryFlights);
  const cleanup = () => {
    if (providerFlights.get(mode) === flight) providerFlights.delete(mode);
    if (providerFlights.size === 0) repositoryFlights.delete(providerId);
    if (repositoryFlights.size === 0) refreshFlights.delete(repository);
  };
  void flight.then(cleanup, cleanup);
  return flight;
}

type RefreshLeaseGuard = {
  readonly race: <T>(operation: Promise<T>) => Promise<T>;
  readonly exchange: <T>(run: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  readonly close: () => void;
};

function createRefreshLeaseGuard(renewLease: () => boolean): RefreshLeaseGuard {
  const controller = new AbortController();
  let rejectLeaseLoss = (_error: Error) => {};
  let stopped = false;
  const leaseLoss = new Promise<never>((_resolve, reject) => {
    rejectLeaseLoss = reject;
  });
  const loseLease = (): void => {
    if (stopped) return;
    rejectLeaseLoss(new CredentialRefreshLeaseLostError());
    controller.abort();
  };
  const renew = setInterval(() => {
    try {
      if (!renewLease()) loseLease();
    } catch {
      loseLease();
    }
  }, REFRESH_RENEW_MS);

  return {
    race(operation) {
      return Promise.race([operation, leaseLoss]);
    },
    async exchange(run) {
      let rejectDeadline = (_error: Error) => {};
      const deadline = new Promise<never>((_resolve, reject) => {
        rejectDeadline = reject;
      });
      const timeout = setTimeout(() => {
        rejectDeadline(new CredentialRefreshTimeoutError());
        controller.abort();
      }, REFRESH_EXCHANGE_TIMEOUT_MS);
      try {
        return await Promise.race([Promise.resolve().then(() => run(controller.signal)), leaseLoss, deadline]);
      } finally {
        clearTimeout(timeout);
      }
    },
    close() {
      stopped = true;
      clearInterval(renew);
    },
  };
}

async function readValidated<Credential>(
  providerId: string,
  schema: ZodType<Credential>,
  repository: PluginRepository,
): Promise<{ readonly account: StoredAccount; readonly snapshot: CredentialSnapshot<Credential> }> {
  const account = repository.readAccount(providerId);
  if (account === null) throw new CredentialAccountMissingError();
  const validated = await parsePluginSchema(schema, account.credential);
  if (!validated.ok) throw new CredentialValidationError(validated.issues);
  return { account, snapshot: { value: validated.value, revision: account.revision } };
}

async function waitForLease<Credential>(
  options: CreateCredentialPortOptions<Credential>,
  owner: string,
  expectedRevision: number,
): Promise<
  { readonly acquired: true } | { readonly acquired: false; readonly snapshot: CredentialSnapshot<Credential> }
> {
  const deadline = Date.now() + REFRESH_WAIT_TIMEOUT_MS;
  let waited = false;
  while (Date.now() <= deadline) {
    const now = Date.now();
    if (options.repository.tryAcquireRefreshLease(options.providerId, owner, now, now + REFRESH_LEASE_MS)) {
      return { acquired: true };
    }
    if (waited) {
      const current = await readValidated(options.providerId, options.schema, options.repository);
      if (current.snapshot.revision !== expectedRevision) return { acquired: false, snapshot: current.snapshot };
    }
    waited = true;
    await delay(REFRESH_POLL_MS + Math.floor(Math.random() * REFRESH_POLL_JITTER_MS));
  }
  throw new CredentialRefreshWaitTimeoutError();
}

function recordRefreshFailure<Credential>(
  options: CreateCredentialPortOptions<Credential>,
  mode: CredentialPortMode,
  error: unknown,
  secretValues: readonly string[],
): void {
  options.logger({
    event: "plugin.credential.refresh.failed",
    code: "CREDENTIAL_REFRESH_FAILED",
    context: { providerId: options.providerId },
    error: redactPluginError(error, { secretValues }),
  });
  if (mode === "control-plane") return;
  if (error instanceof CredentialRefreshError && error.retryable) return;
  const diagnostic = options.diagnostics("CREDENTIAL_REFRESH_FAILED", {
    providerId: options.providerId,
    retryable: false,
    suggestedCommand: providerLoginCommand(options.providerId),
  });
  try {
    if (options.repository.writeDiagnostic(options.providerId, diagnostic)) options.onDiagnosticChanged();
  } catch {}
}

export function createCredentialPort<Credential>(
  options: CreateCredentialPortOptions<Credential>,
): CredentialPort<Credential> {
  const mode = options.mode ?? "runtime";
  return {
    async read() {
      return (await readValidated(options.providerId, options.schema, options.repository)).snapshot;
    },
    refresh(expectedRevision, exchange) {
      return singleFlight(options.repository, options.providerId, mode, async () => {
        const owner = `${process.pid}:${crypto.randomUUID()}`;
        let secretValues: readonly string[] = [];
        try {
          const lease = await waitForLease(options, owner, expectedRevision);
          if (!lease.acquired) return { status: "superseded", snapshot: lease.snapshot };
          const guard = createRefreshLeaseGuard(() =>
            options.repository.renewRefreshLease(options.providerId, owner, Date.now() + REFRESH_LEASE_MS),
          );
          try {
            const current = await guard.race(readValidated(options.providerId, options.schema, options.repository));
            secretValues = [
              ...collectSecretStrings(current.snapshot.value),
              ...collectSecretStrings(current.account.secrets),
              ...(options.mode === "control-plane"
                ? (options.additionalSecretValues ?? [])
                : collectSecretStrings(options.pluginSecrets)),
            ];
            if (current.snapshot.revision !== expectedRevision) {
              return { status: "superseded", snapshot: current.snapshot };
            }
            const exchanged = await guard.exchange((signal) => exchange(current.snapshot, signal));
            secretValues = [...secretValues, ...collectSecretStrings(exchanged.value)];
            const validated = await guard.race(parsePluginSchema(options.schema, exchanged.value));
            if (!validated.ok) throw new CredentialValidationError(validated.issues);
            const updated = options.repository.compareAndSwapCredential(
              options.providerId,
              expectedRevision,
              owner,
              validated.value,
              exchanged.metadata,
            );
            if (updated === null) {
              const latest = await guard.race(readValidated(options.providerId, options.schema, options.repository));
              if (latest.snapshot.revision === expectedRevision) throw new CredentialRefreshLeaseLostError();
              return { status: "superseded", snapshot: latest.snapshot };
            }
            if (mode !== "control-plane") {
              if (options.repository.clearDiagnostic(options.providerId, "CREDENTIAL_REFRESH_FAILED")) {
                options.onDiagnosticChanged();
              }
              if (
                (exchanged.metadata?.label !== undefined && exchanged.metadata.label !== current.account.label) ||
                (exchanged.metadata?.expiresAt !== undefined &&
                  exchanged.metadata.expiresAt !== current.account.expiresAt)
              ) {
                options.onCredentialChanged();
              }
            }
            return { status: "updated", snapshot: { value: validated.value, revision: updated.revision } };
          } finally {
            guard.close();
            options.repository.releaseRefreshLease(options.providerId, owner);
          }
        } catch (error) {
          recordRefreshFailure(options, mode, error, secretValues);
          throw error;
        }
      });
    },
  };
}
