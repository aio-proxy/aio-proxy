import {
  type CredentialPort,
  CredentialRefreshError,
  type CredentialSnapshot,
  type RuntimeContext,
} from "@aio-proxy/plugin-sdk";
import type { GoogleAntigravityAccountOptions, GoogleAntigravityCredential } from "../schema";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_TOKEN_ENDPOINT } from "./constants";
import type { OAuthHttpOptions } from "./flow";

const REFRESH_WINDOW_MS = 300_000;

type CredentialSource =
  | CredentialPort<GoogleAntigravityCredential>
  | Pick<RuntimeContext<GoogleAntigravityCredential, GoogleAntigravityAccountOptions>, "credentials">;

export async function refreshGoogleCredential(
  credential: GoogleAntigravityCredential,
  options: OAuthHttpOptions = {},
): Promise<GoogleAntigravityCredential> {
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: credential.refreshToken,
        grant_type: "refresh_token",
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    throw refreshError(true, "network");
  }

  if (!response.ok) throw classifyResponse(response.status, await readErrorPayload(response));
  const payload = await readPayload(response);
  const accessToken = readString(payload, "access_token");
  const expiresIn = payload["expires_in"];
  if (accessToken === undefined || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn < 0) {
    throw refreshError(false, "invalid_payload");
  }
  const refreshToken = readString(payload, "refresh_token") ?? credential.refreshToken;
  const tokenType = readString(payload, "token_type") ?? credential.tokenType;
  const scope = readString(payload, "scope") ?? credential.scope;
  return {
    accessToken,
    refreshToken,
    expiresAt: (options.now ?? Date.now)() + expiresIn * 1_000,
    email: credential.email,
    projectId: credential.projectId,
    ...(tokenType === undefined ? {} : { tokenType }),
    ...(scope === undefined ? {} : { scope }),
  };
}

export async function currentGoogleCredential(
  source: CredentialSource,
  options: OAuthHttpOptions = {},
): Promise<CredentialSnapshot<GoogleAntigravityCredential>> {
  const credentials = credentialPort(source);
  options.signal?.throwIfAborted();
  const current = await waitForCaller(credentials.read(), options.signal);
  options.signal?.throwIfAborted();
  if ((options.now ?? Date.now)() < current.value.expiresAt - REFRESH_WINDOW_MS) return current;
  return await refreshThroughPort(credentials, current.revision, options);
}

export async function forceRefreshGoogleCredential(
  source: CredentialSource,
  options: OAuthHttpOptions = {},
): Promise<CredentialSnapshot<GoogleAntigravityCredential>> {
  const credentials = credentialPort(source);
  options.signal?.throwIfAborted();
  const current = await waitForCaller(credentials.read(), options.signal);
  return await refreshThroughPort(credentials, current.revision, options);
}

async function refreshThroughPort(
  credentials: CredentialPort<GoogleAntigravityCredential>,
  revision: number,
  options: OAuthHttpOptions,
): Promise<CredentialSnapshot<GoogleAntigravityCredential>> {
  options.signal?.throwIfAborted();
  const refreshing = credentials.refresh(revision, async (current, signal) => {
    const value = await refreshGoogleCredential(current.value, { ...options, signal });
    return { value, metadata: { label: value.email, expiresAt: value.expiresAt } };
  });
  const result = await waitForCaller(refreshing, options.signal);
  return result.snapshot;
}

async function waitForCaller<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await operation;
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw error instanceof SyntaxError ? refreshError(false, "invalid_payload") : refreshError(true, "network");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw refreshError(false, "invalid_payload");
  }
  return payload as Record<string, unknown>;
}

async function readErrorPayload(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload: unknown = await response.json();
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
  } catch {}
  return {};
}

function classifyResponse(status: number, payload: Record<string, unknown>): CredentialRefreshError {
  if (status === 408) return refreshError(true, "request_timeout", status);
  if (status === 429) return refreshError(true, "rate_limited", status);
  if (status >= 500) return refreshError(true, "upstream_5xx", status);
  const code = readString(payload, "error")?.toLowerCase();
  const description = readString(payload, "error_description")?.toLowerCase();
  if (code === "invalid_grant" || description?.includes("revok") === true) {
    return refreshError(false, "invalid_grant", status);
  }
  if (
    status === 401 ||
    status === 403 ||
    code === "invalid_client" ||
    code === "unauthorized_client" ||
    code === "access_denied"
  ) {
    return refreshError(false, "credential_rejected", status);
  }
  return refreshError(false, "request_rejected", status);
}

function refreshError(retryable: boolean, reason: string, status?: number): CredentialRefreshError {
  return new CredentialRefreshError("Google token refresh failed", {
    retryable,
    reason,
    ...(status === undefined ? {} : { status }),
  });
}

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}

function credentialPort(source: CredentialSource): CredentialPort<GoogleAntigravityCredential> {
  return "read" in source ? source : source.credentials;
}
