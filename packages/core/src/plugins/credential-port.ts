import type { CredentialPort, CredentialSnapshot, ZodType } from "@aio-proxy/plugin-sdk";
import type { DiagnosticFactory, PluginLogSink } from "./diagnostic";
import { redactPluginError } from "./diagnostic";
import type { PluginRepository, StoredAccount } from "./repository";
import { parsePluginSchema } from "./schema";

const REFRESH_LEASE_MS = 45_000;
const REFRESH_RENEW_MS = 15_000;
const REFRESH_EXCHANGE_TIMEOUT_MS = 30_000;
const REFRESH_WAIT_TIMEOUT_MS = 60_000;
const REFRESH_POLL_MS = 100;
const REFRESH_POLL_JITTER_MS = 25;

type RefreshResult<Credential> = Awaited<ReturnType<CredentialPort<Credential>["refresh"]>>;

export type CreateCredentialPortOptions<Credential> = {
  readonly providerId: string;
  readonly schema: ZodType<Credential>;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly onDiagnosticChanged: () => void;
};

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

export class CredentialAccountMissingError extends Error {
  constructor() {
    super("Credential account is unavailable");
    this.name = "CredentialAccountMissingError";
  }
}

const refreshFlights = new Map<string, Promise<RefreshResult<unknown>>>();

function singleFlight<Credential>(
  providerId: string,
  run: () => Promise<RefreshResult<Credential>>,
): Promise<RefreshResult<Credential>> {
  const existing = refreshFlights.get(providerId);
  if (existing !== undefined) return existing as Promise<RefreshResult<Credential>>;
  const flight = run();
  refreshFlights.set(providerId, flight as Promise<RefreshResult<unknown>>);
  const cleanup = () => {
    if (refreshFlights.get(providerId) === flight) refreshFlights.delete(providerId);
  };
  void flight.then(cleanup, cleanup);
  return flight;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stringLeaves(value: unknown): readonly string[] {
  const leaves: string[] = [];
  const seen = new Set<object>();
  const visit = (current: unknown): void => {
    if (typeof current === "string") {
      leaves.push(current);
      return;
    }
    if (typeof current !== "object" || current === null || seen.has(current)) return;
    seen.add(current);
    try {
      for (const child of Object.values(current)) visit(child);
    } catch {
      return;
    }
  };
  visit(value);
  return leaves;
}

async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new CredentialRefreshTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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
    await sleep(REFRESH_POLL_MS + Math.floor(Math.random() * REFRESH_POLL_JITTER_MS));
  }
  throw new CredentialRefreshWaitTimeoutError();
}

function recordRefreshFailure<Credential>(
  options: CreateCredentialPortOptions<Credential>,
  error: unknown,
  secretValues: readonly string[],
): void {
  options.logger({
    event: "plugin.credential.refresh.failed",
    code: "CREDENTIAL_REFRESH_FAILED",
    context: { providerId: options.providerId },
    error: redactPluginError(error, { secretValues }),
  });
  const diagnostic = options.diagnostics("CREDENTIAL_REFRESH_FAILED", {
    providerId: options.providerId,
    retryable: true,
  });
  if (options.repository.writeDiagnostic(options.providerId, diagnostic)) options.onDiagnosticChanged();
}

export function createCredentialPort<Credential>(
  options: CreateCredentialPortOptions<Credential>,
): CredentialPort<Credential> {
  return {
    async read() {
      return (await readValidated(options.providerId, options.schema, options.repository)).snapshot;
    },
    refresh(expectedRevision, exchange) {
      return singleFlight(options.providerId, async () => {
        const owner = `${process.pid}:${crypto.randomUUID()}`;
        let secretValues: readonly string[] = [];
        try {
          const lease = await waitForLease(options, owner, expectedRevision);
          if (!lease.acquired) return { status: "superseded", snapshot: lease.snapshot };
          const renew = setInterval(() => {
            options.repository.renewRefreshLease(options.providerId, owner, Date.now() + REFRESH_LEASE_MS);
          }, REFRESH_RENEW_MS);
          try {
            const current = await readValidated(options.providerId, options.schema, options.repository);
            secretValues = stringLeaves(current.snapshot.value);
            if (current.snapshot.revision !== expectedRevision) {
              return { status: "superseded", snapshot: current.snapshot };
            }
            const exchanged = await withDeadline(
              (signal) => exchange(current.snapshot, signal),
              REFRESH_EXCHANGE_TIMEOUT_MS,
            );
            secretValues = [...secretValues, ...stringLeaves(exchanged.value)];
            const validated = await parsePluginSchema(options.schema, exchanged.value);
            if (!validated.ok) throw new CredentialValidationError(validated.issues);
            const updated = options.repository.compareAndSwapCredential(
              options.providerId,
              expectedRevision,
              validated.value,
              exchanged.metadata,
            );
            if (updated === null) {
              const latest = await readValidated(options.providerId, options.schema, options.repository);
              return { status: "superseded", snapshot: latest.snapshot };
            }
            if (options.repository.clearDiagnostic(options.providerId, "CREDENTIAL_REFRESH_FAILED")) {
              options.onDiagnosticChanged();
            }
            return { status: "updated", snapshot: { value: validated.value, revision: updated.revision } };
          } finally {
            clearInterval(renew);
            options.repository.releaseRefreshLease(options.providerId, owner);
          }
        } catch (error) {
          recordRefreshFailure(options, error, secretValues);
          throw error;
        }
      });
    },
  };
}
