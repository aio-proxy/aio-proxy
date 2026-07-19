import { setTimeout as delay } from "node:timers/promises";
import {
  type CredentialPort,
  CredentialRefreshError,
  type LocalizedText,
  type OAuthLoginContext,
  zod,
} from "@aio-proxy/plugin-sdk";
import { isRetryableStatus, postForm, postFormResponse, request, XAIOAuthHttpError } from "./oauth/http";
import type { XAIGrokCredential } from "./schema";

const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const REFRESH_WINDOW_MS = 300_000;

const discoverySchema = zod
  .object({
    device_authorization_endpoint: zod.string().min(1),
    token_endpoint: zod.string().min(1),
  })
  .loose();
const deviceSchema = zod
  .object({
    device_code: zod.string().min(1),
    user_code: zod.string().min(1),
    verification_uri: zod.string().optional(),
    verification_uri_complete: zod.string().optional(),
    expires_in: zod.number().positive(),
    interval: zod.number().positive(),
  })
  .loose();
const tokenSchema = zod
  .object({
    access_token: zod.string().optional(),
    refresh_token: zod.string().optional(),
    id_token: zod.string().optional(),
    expires_in: zod.number().optional(),
    error: zod.string().optional(),
  })
  .loose();

export type XAIGrokFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type XAIGrokOAuthOptions = {
  readonly fetch?: XAIGrokFetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly deviceInstructions?: LocalizedText;
  readonly waitingForAuthorization?: LocalizedText;
  readonly signal?: AbortSignal;
};

export function validateXAIEndpoint(value: string, field: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`Invalid xAI ${field}`);
  }
  const host = endpoint.hostname.toLowerCase();
  if (endpoint.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
    throw new Error(`Invalid xAI ${field}`);
  }
  return value;
}

export async function loginXAIGrok(context: OAuthLoginContext, options: XAIGrokOAuthOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  const endpoints = await discover(fetcher, context.signal);
  const device = deviceSchema.parse(
    await postForm(fetcher, endpoints.device, { client_id: CLIENT_ID, scope: SCOPE }, context.signal),
  );
  const verification = device.verification_uri_complete ?? device.verification_uri;
  if (verification === undefined) throw new Error("xAI device response is missing verification URI");
  validateXAIEndpoint(verification, "verification_uri");
  await context.authorization.presentDeviceCode({
    url: verification,
    userCode: device.user_code,
    instructions: appendCode(options.deviceInstructions ?? "Enter code", device.user_code),
  });

  let interval = Math.max(device.interval, 5);
  const deadline = now() + device.expires_in * 1_000;
  while (now() <= deadline) {
    context.signal.throwIfAborted();
    const response = await postFormResponse(
      fetcher,
      endpoints.token,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CLIENT_ID,
        device_code: device.device_code,
      },
      context.signal,
    );
    const body = tokenSchema.parse(await response.json());
    if (response.ok) return loginResult(body, now());
    if (body.error !== "authorization_pending" && body.error !== "slow_down") {
      throw new Error(`xAI device authorization failed: ${body.error ?? response.status}`);
    }
    if (body.error === "slow_down") interval += 5;
    context.progress(options.waitingForAuthorization ?? "Waiting for xAI authorization");
    await sleep(interval * 1_000, context.signal);
  }
  throw new Error("xAI device authorization timed out");
}

export async function refreshXAIGrokCredential(
  credential: XAIGrokCredential,
  options: XAIGrokOAuthOptions = {},
): Promise<XAIGrokCredential> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const signal = options.signal ?? new AbortController().signal;
  try {
    const endpoints = await discover(fetcher, signal);
    const response = await postFormResponse(
      fetcher,
      endpoints.token,
      { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: credential.refreshToken },
      signal,
    );
    if (!response.ok) {
      const body = tokenSchema.safeParse(await readJson(response));
      const oauthError = body.success ? body.data.error : undefined;
      const reason = oauthError === "invalid_grant" ? "invalid_grant" : classifyStatus(response.status);
      throw refreshError(isRetryableStatus(response.status), reason, response.status);
    }
    const body = tokenSchema.parse(await response.json());
    const accessToken = body.access_token?.trim();
    if (!accessToken || body.expires_in === undefined || body.expires_in <= 0) {
      throw refreshError(false, "invalid_payload");
    }
    return {
      ...credential,
      accessToken,
      refreshToken: body.refresh_token?.trim() || credential.refreshToken,
      expiresAt: (options.now ?? Date.now)() + body.expires_in * 1_000,
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof CredentialRefreshError) throw error;
    if (error instanceof XAIOAuthHttpError) throw refreshError(error.retryable, "discovery_failed", error.status);
    throw refreshError(false, "invalid_payload");
  }
}

export async function currentXAIGrokCredential(
  port: CredentialPort<XAIGrokCredential>,
  options: XAIGrokOAuthOptions = {},
): Promise<XAIGrokCredential> {
  options.signal?.throwIfAborted();
  const current = await waitForCaller(port.read(), options.signal);
  if ((options.now ?? Date.now)() < current.value.expiresAt - REFRESH_WINDOW_MS) return current.value;
  const refreshed = port.refresh(current.revision, async ({ value }, signal) => {
    const next = await refreshXAIGrokCredential(value, { ...options, signal });
    return { value: next, metadata: { expiresAt: next.expiresAt } };
  });
  return (await waitForCaller(refreshed, options.signal)).snapshot.value;
}

async function discover(fetcher: XAIGrokFetch, signal: AbortSignal) {
  const response = await request(fetcher, DISCOVERY_URL, { headers: { accept: "application/json" }, signal });
  if (!response.ok) {
    throw new XAIOAuthHttpError("xAI discovery failed", isRetryableStatus(response.status), response.status);
  }
  const body = discoverySchema.parse(await response.json());
  return {
    device: validateXAIEndpoint(body.device_authorization_endpoint, "device_authorization_endpoint"),
    token: validateXAIEndpoint(body.token_endpoint, "token_endpoint"),
  };
}

function loginResult(body: zod.infer<typeof tokenSchema>, now: number) {
  const accessToken = body.access_token?.trim();
  const refreshToken = body.refresh_token?.trim();
  if (!accessToken || !refreshToken || body.expires_in === undefined || body.expires_in <= 0) {
    throw new Error("xAI token response is missing credentials or expiry");
  }
  const claims = readClaims(body.id_token ?? accessToken);
  const email = readClaim(claims, "email");
  const subject = readClaim(claims, "sub");
  const identity =
    subject === undefined
      ? email === undefined
        ? `refresh:${refreshToken}`
        : `email:${email.toLowerCase()}`
      : `sub:${subject}`;
  const digest = new Bun.CryptoHasher("sha256").update(identity).digest("hex");
  const expiresAt = now + body.expires_in * 1_000;
  const credentials = {
    accessToken,
    refreshToken,
    expiresAt,
    ...(email === undefined ? {} : { email }),
    ...(subject === undefined ? {} : { subject }),
  };
  return {
    fingerprint: `sha256:${digest}`,
    suggestedKey: `grok-${digest.slice(0, 12)}`,
    label: email ?? subject ?? "xAI Grok",
    credentials,
    expiresAt,
  };
}

function readClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1];
    const value: unknown = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readClaim(claims: Record<string, unknown>, key: string): string | undefined {
  const value = claims[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function appendCode(text: LocalizedText, code: string): LocalizedText {
  if (typeof text === "string") return `${text} ${code}`;
  return Object.fromEntries(
    Object.entries(text).map(([locale, value]) => [locale, `${value} ${code}`]),
  ) as LocalizedText;
}

function classifyStatus(status: number): string {
  return status === 429 ? "rate_limited" : status >= 500 ? "upstream_5xx" : "request_rejected";
}

function refreshError(retryable: boolean, reason: string, status?: number) {
  return new CredentialRefreshError("xAI token refresh failed", {
    retryable,
    reason,
    ...(status === undefined ? {} : { status }),
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
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
