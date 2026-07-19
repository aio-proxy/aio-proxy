import type { LocalizedText, OAuthLoginContext } from "@aio-proxy/plugin-sdk";
import { kimiIdentityHeaders } from "./headers";
import { KIMI_OAUTH_BASE_URL } from "./oauth/constants";

export { currentKimiCredential, refreshKimiCredential } from "./oauth/credential";

declare const __AIO_PROXY_KIMI_CLIENT_ID__: string;

const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

export type KimiCredential = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly deviceId: string;
};

export type KimiOAuthDependencies = {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly deviceId?: () => string;
};

export type KimiLoginPresentation = {
  readonly instructions: LocalizedText;
  readonly waiting: LocalizedText;
};

type DeviceAuthorization = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn: number;
  readonly interval: number;
};

type TokenResponse = {
  readonly accessToken: string | undefined;
  readonly refreshToken: string | undefined;
  readonly expiresIn: number | undefined;
  readonly error: string | undefined;
  readonly interval: number | undefined;
};

export async function loginKimi(
  context: OAuthLoginContext,
  presentation: KimiLoginPresentation,
  dependencies: KimiOAuthDependencies = {},
) {
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? abortableSleep;
  const deviceId = dependencies.deviceId?.() ?? crypto.randomUUID().replaceAll("-", "");
  const device = await requestDeviceAuthorization(fetcher, deviceId, context.signal);
  await context.authorization.presentDeviceCode({
    url: device.verificationUriComplete ?? device.verificationUri,
    userCode: device.userCode,
    instructions: appendCode(presentation.instructions, device.userCode),
  });

  const deadline = now() + device.expiresIn * 1_000;
  let intervalMs = device.interval * 1_000;
  while (now() <= deadline) {
    context.signal.throwIfAborted();
    const token = await requestToken(fetcher, deviceId, context.signal, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.deviceCode,
    });
    if (token.accessToken !== undefined) {
      const credential = completeCredential(token, deviceId, now());
      const fingerprint = await sha256(credential.refreshToken);
      return {
        fingerprint,
        suggestedKey: `kimi-${fingerprint.slice(0, 12)}`,
        label: "Kimi Code",
        credentials: credential,
        expiresAt: credential.expiresAt,
      };
    }
    if (token.error === "authorization_pending") {
      context.progress(presentation.waiting);
      await sleep(intervalMs, context.signal);
      continue;
    }
    if (token.error === "slow_down") {
      intervalMs = Math.max(intervalMs + 5_000, (token.interval ?? 0) * 1_000);
      await sleep(intervalMs, context.signal);
      continue;
    }
    if (token.error === "expired_token") throw new Error("Kimi device authorization expired");
    if (token.error === "access_denied") throw new Error("Kimi device authorization denied");
    throw new Error("Kimi device authorization failed");
  }
  throw new Error("Kimi device authorization timed out");
}

async function requestDeviceAuthorization(
  fetcher: typeof fetch,
  deviceId: string,
  signal: AbortSignal,
): Promise<DeviceAuthorization> {
  const value = await postForm(fetcher, `${KIMI_OAUTH_BASE_URL}/device_authorization`, deviceId, signal, {});
  const deviceCode = optionalString(value, "device_code");
  const userCode = optionalString(value, "user_code");
  const verificationUri = optionalString(value, "verification_uri");
  const verificationUriComplete = optionalString(value, "verification_uri_complete");
  const expiresIn = optionalPositiveNumber(value, "expires_in") ?? 900;
  const interval = optionalPositiveNumber(value, "interval") ?? 5;
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    throw new Error("Kimi device authorization response is invalid");
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(verificationUriComplete === undefined ? {} : { verificationUriComplete }),
    expiresIn,
    interval,
  };
}

async function requestToken(
  fetcher: typeof fetch,
  deviceId: string,
  signal: AbortSignal,
  form: Readonly<Record<string, string>>,
): Promise<TokenResponse> {
  const value = await postForm(fetcher, `${KIMI_OAUTH_BASE_URL}/token`, deviceId, signal, form, true);
  return {
    accessToken: optionalString(value, "access_token"),
    refreshToken: optionalString(value, "refresh_token"),
    expiresIn: optionalPositiveNumber(value, "expires_in"),
    error: optionalString(value, "error"),
    interval: optionalPositiveNumber(value, "interval"),
  };
}

async function postForm(
  fetcher: typeof fetch,
  url: string,
  deviceId: string,
  signal: AbortSignal,
  form: Readonly<Record<string, string>>,
  acceptBadRequest = false,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...kimiIdentityHeaders(deviceId) },
      body: new URLSearchParams({ client_id: __AIO_PROXY_KIMI_CLIENT_ID__, ...form }),
      signal,
    });
  } catch {
    signal.throwIfAborted();
    throw new Error("Kimi OAuth request failed");
  }
  if (acceptBadRequest && isRetryableStatus(response.status)) return { error: "authorization_pending" };
  if (!response.ok && (!acceptBadRequest || response.status !== 400)) throw new Error("Kimi OAuth request failed");
  return parseObject(response, "Kimi OAuth response is invalid");
}

async function parseObject(response: Response, message: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {}
  throw new Error(message);
}

function completeCredential(token: TokenResponse, deviceId: string, now: number): KimiCredential {
  if (token.accessToken === undefined || token.refreshToken === undefined || token.expiresIn === undefined) {
    throw new Error("Kimi OAuth token response is invalid");
  }
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: now + token.expiresIn * 1_000,
    deviceId,
  };
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field !== "" ? field : undefined;
}

function optionalPositiveNumber(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) && field > 0 ? field : undefined;
}

function appendCode(text: LocalizedText, code: string): LocalizedText {
  if (typeof text === "string") return `${text}\n\n${code}`;
  return Object.fromEntries(
    Object.entries(text).map(([locale, value]) => [locale, `${value}\n\n${code}`]),
  ) as LocalizedText;
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
