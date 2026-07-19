import { type CredentialPort, CredentialRefreshError } from "@aio-proxy/plugin-sdk";
import { kimiIdentityHeaders } from "../headers";
import type { KimiCredential, KimiOAuthDependencies } from "../oauth";
import { KIMI_OAUTH_BASE_URL } from "./constants";

declare const __AIO_PROXY_KIMI_CLIENT_ID__: string;

export async function refreshKimiCredential(
  current: KimiCredential,
  options: KimiOAuthDependencies & { readonly signal?: AbortSignal } = {},
): Promise<KimiCredential> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let response: Response;
  try {
    response = await fetcher(`${KIMI_OAUTH_BASE_URL}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...kimiIdentityHeaders(current.deviceId) },
      body: new URLSearchParams({
        client_id: __AIO_PROXY_KIMI_CLIENT_ID__,
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
      }),
      signal: options.signal ?? null,
    });
  } catch {
    throw refreshError(true, "network");
  }
  if (!response.ok) {
    const oauthError = await readOAuthError(response);
    const invalidGrant = oauthError === "invalid_grant";
    throw refreshError(
      !invalidGrant && isRetryableStatus(response.status),
      invalidGrant ? "invalid_grant" : response.status === 401 || response.status === 403 ? "rejected" : "http",
      response.status,
    );
  }
  const token = await parseSuccessfulToken(response);
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? current.refreshToken,
    expiresAt: now() + token.expiresIn * 1_000,
    deviceId: current.deviceId,
  };
}

export async function currentKimiCredential(
  port: CredentialPort<KimiCredential>,
  options: KimiOAuthDependencies & { readonly signal?: AbortSignal } = {},
): Promise<KimiCredential> {
  options.signal?.throwIfAborted();
  const current = await waitForCaller(port.read(), options.signal);
  options.signal?.throwIfAborted();
  const now = options.now ?? Date.now;
  if (current.value.expiresAt > now() + 5 * 60_000) return current.value;
  const refreshing = port.refresh(current.revision, async ({ value }, signal) => {
    const refreshed = await refreshKimiCredential(value, { ...options, signal });
    return { value: refreshed, metadata: { expiresAt: refreshed.expiresAt } };
  });
  return (await waitForCaller(refreshing, options.signal)).snapshot.value;
}

async function parseSuccessfulToken(
  response: Response,
): Promise<{ readonly accessToken: string; readonly refreshToken?: string; readonly expiresIn: number }> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw error instanceof SyntaxError ? refreshError(false, "invalid") : refreshError(true, "network");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw refreshError(false, "invalid");
  const record = value as Record<string, unknown>;
  const accessToken = optionalString(record, "access_token");
  const refreshToken = optionalString(record, "refresh_token");
  const expiresIn = optionalPositiveNumber(record, "expires_in");
  if (accessToken === undefined || expiresIn === undefined) throw refreshError(false, "invalid");
  return { accessToken, ...(refreshToken === undefined ? {} : { refreshToken }), expiresIn };
}

async function readOAuthError(response: Response): Promise<string | undefined> {
  try {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? optionalString(value as Record<string, unknown>, "error")
      : undefined;
  } catch {
    return undefined;
  }
}

function refreshError(retryable: boolean, reason: string, status?: number): CredentialRefreshError {
  return new CredentialRefreshError("Kimi credential refresh failed", {
    retryable,
    reason,
    ...(status === undefined ? {} : { status }),
  });
}

const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field !== "" ? field : undefined;
}

function optionalPositiveNumber(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) && field > 0 ? field : undefined;
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
