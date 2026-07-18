import {
  type AuthorizationPort,
  CATALOG_DISCOVERY_TIMEOUT_MS,
  type LocalizedText,
  type OAuthAdapter,
} from "@aio-proxy/plugin-sdk";
import { OAuthCatalogDiscoveryTimeoutError, OAuthLoginTimeoutError } from "./errors";

export const LOGIN_TIMEOUT_MS = 20 * 60_000;
export { CATALOG_DISCOVERY_TIMEOUT_MS };

const hostAuthorizationErrors = new WeakMap<object, unknown>();

function protectHostAuthorizationError(error: unknown): Error {
  const carrier = new Error("HOST_AUTHORIZATION_FAILED");
  hostAuthorizationErrors.set(carrier, error);
  return carrier;
}

function authorizationFailed(reason: "authorization_port" | "oauth_adapter"): Error {
  const error = new Error("AUTHORIZATION_FAILED");
  error.name = "OAuthAuthorizationFailedError";
  return Object.assign(error, {
    code: "AUTHORIZATION_FAILED" as const,
    reason,
    detail: reason === "authorization_port" ? "HOST_AUTHORIZATION_FAILED" : "OAUTH_ADAPTER_LOGIN_FAILED",
  });
}

export function protectedAuthorization(authorization: AuthorizationPort): AuthorizationPort {
  return {
    async presentDeviceCode(input) {
      try {
        await authorization.presentDeviceCode(input);
      } catch (error) {
        throw protectHostAuthorizationError(error);
      }
    },
    async loopback(input) {
      try {
        return await authorization.loopback(input);
      } catch (error) {
        throw protectHostAuthorizationError(error);
      }
    },
  };
}

export function preservedAuthorizationError(
  error: unknown,
): { readonly found: false } | { readonly found: true; readonly value: unknown } {
  if (typeof error !== "object" || error === null || !hostAuthorizationErrors.has(error)) return { found: false };
  return { found: true, value: hostAuthorizationErrors.get(error) };
}

export async function loginWithProtectedAuthorization<Options, Credential>(
  adapter: OAuthAdapter<Options, Credential>,
  createAuthorization: () => AuthorizationPort,
  progress: (message: LocalizedText) => void,
  signal: AbortSignal,
  options: Options,
): Promise<Awaited<ReturnType<OAuthAdapter<Options, Credential>["login"]>>> {
  try {
    return await withAbort(signal, () => {
      let authorization: AuthorizationPort;
      try {
        authorization = createAuthorization();
      } catch (error) {
        throw protectHostAuthorizationError(error);
      }
      return adapter.login({ authorization: protectedAuthorization(authorization), progress, signal }, options);
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    const preserved = preservedAuthorizationError(error);
    if (preserved.found) throw preserved.value;
    throw authorizationFailed("oauth_adapter");
  }
}

export function deadlineController(parent?: AbortSignal): { readonly signal: AbortSignal; readonly close: () => void } {
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

export function childDeadline(
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

export async function withAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
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
