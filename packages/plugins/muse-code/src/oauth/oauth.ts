import type { CredentialPort, LocalizedText, OAuthLoginContext, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import {
  isRetryableStatus,
  MuseCodeHttpError,
  museControlFetch,
  museControlHeaders,
  requestMuseCodeKey,
  type MuseCodeKeyResponse,
} from '../control';
import type { MuseCodeCredential } from '../schema';

export const MUSE_CLIENT_ID = '1031625952748946';
export const MUSE_DEVICE_URL = 'https://auth.meta.com/oidc/device/authorization/';
export const MUSE_TOKEN_URL = 'https://auth.meta.com/oidc/device/token/';

export type MuseCodeOAuthOptions = {
  readonly fetch?: RuntimeFetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly deviceInstructions?: LocalizedText;
  readonly waitingForAuthorization?: LocalizedText;
};

type DeviceAuthorization = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly interval: number;
};

export function normalizeMuseEmail(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email === '' ? undefined : email;
}

export function museLoginResult(credential: MuseCodeCredential) {
  const email = normalizeMuseEmail(credential.email);
  const accountId = credential.accountId?.trim() || undefined;
  const normalized: MuseCodeCredential = {
    oauthAccessToken: credential.oauthAccessToken,
    apiKey: credential.apiKey,
    ...(email === undefined ? {} : { email }),
    ...(accountId === undefined ? {} : { accountId }),
  };
  let identity: string | undefined;
  if (accountId !== undefined) identity = `account:${accountId}`;
  else if (email !== undefined) identity = `email:${email}`;
  if (identity === undefined) throw new Error('Muse Code key response is missing a stable account identity');
  const digest = new Bun.CryptoHasher('sha256').update(identity).digest('hex');
  return {
    fingerprint: `sha256:${digest}`,
    suggestedKey: `muse-${digest.slice(0, 12)}`,
    accountLabel: email ?? accountId ?? 'Muse Code',
    credentials: normalized,
  };
}

export async function currentMuseCodeCredential(
  port: CredentialPort<MuseCodeCredential>,
  options: MuseCodeOAuthOptions = {},
): Promise<MuseCodeCredential> {
  options.signal?.throwIfAborted();
  const current = await port.read();
  options.signal?.throwIfAborted();
  return current.value;
}

export async function loginMuseCode(context: OAuthLoginContext, options: MuseCodeOAuthOptions = {}) {
  const fetcher = options.fetch ?? context.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const waiting = options.waitingForAuthorization ?? 'Waiting for Muse authorization';
  const device = await requestDeviceAuthorization(fetcher, context.signal);
  await context.authorization.presentDeviceCode({
    url: device.verificationUri,
    userCode: device.userCode,
    instructions: appendCode(options.deviceInstructions ?? 'Enter code', device.userCode),
  });
  const accessToken = await pollDeviceToken(context, {
    fetcher,
    device,
    now,
    sleep,
    waiting,
  });
  const payload = await requestMuseCodeKey(accessToken, {
    onboard: true,
    fetch: fetcher,
    signal: context.signal,
  });
  return completeMuseLogin(accessToken, payload);
}

async function requestDeviceAuthorization(fetcher: RuntimeFetch, signal: AbortSignal): Promise<DeviceAuthorization> {
  const response = await postDeviceForm(fetcher, MUSE_DEVICE_URL, { client_id: MUSE_CLIENT_ID }, signal);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Muse Code device authorization failed');
  }
  const value = await parseJsonObject(response, 'Muse Code device authorization response is invalid');
  const deviceCode = optionalString(value, 'device_code');
  const userCode = optionalString(value, 'user_code');
  const verificationUri =
    optionalString(value, 'verification_uri_complete') ?? optionalString(value, 'verification_uri');
  const expiresIn = optionalPositiveNumber(value, 'expires_in') ?? 900;
  const interval = optionalPositiveNumber(value, 'interval') ?? 5;
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    throw new Error('Muse Code device authorization response is invalid');
  }
  return { deviceCode, userCode, verificationUri, expiresIn, interval };
}

async function pollDeviceToken(
  context: OAuthLoginContext,
  input: {
    readonly fetcher: RuntimeFetch;
    readonly device: DeviceAuthorization;
    readonly now: () => number;
    readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    readonly waiting: LocalizedText;
  },
): Promise<string> {
  let interval = Math.max(input.device.interval, 5);
  const deadline = input.now() + input.device.expiresIn * 1_000;
  while (input.now() <= deadline) {
    context.signal.throwIfAborted();
    let response: Response;
    try {
      response = await postDeviceForm(
        input.fetcher,
        MUSE_TOKEN_URL,
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: MUSE_CLIENT_ID,
          device_code: input.device.deviceCode,
        },
        context.signal,
      );
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      if (!(error instanceof MuseCodeHttpError) || !error.retryable) throw error;
      context.progress(input.waiting);
      await input.sleep(interval * 1_000, context.signal);
      continue;
    }
    if (isRetryableStatus(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      context.progress(input.waiting);
      await input.sleep(interval * 1_000, context.signal);
      continue;
    }
    const body = await parseJsonObject(response, 'Muse Code device authorization failed');
    const accessToken = optionalString(body, 'access_token');
    if (accessToken !== undefined) return accessToken;
    const error = optionalString(body, 'error');
    if (error === 'authorization_pending') {
      context.progress(input.waiting);
      await input.sleep(interval * 1_000, context.signal);
      continue;
    }
    if (error === 'slow_down') {
      interval = Math.max(interval + 5, optionalPositiveNumber(body, 'interval') ?? 0);
      await input.sleep(interval * 1_000, context.signal);
      continue;
    }
    if (error === 'access_denied') throw new Error('Muse Code device authorization denied');
    if (error === 'expired_token') throw new Error('Muse Code device authorization expired');
    throw new Error('Muse Code device authorization failed');
  }
  throw new Error('Muse Code device authorization timed out');
}

function completeMuseLogin(accessToken: string, payload: MuseCodeKeyResponse) {
  if (payload.require_payment === true) throw new Error('Muse Code payment_required');
  if (payload.is_subs_active === false) throw new Error('Muse Code subscription is inactive');
  const apiKey = payload.api_key?.trim();
  if (apiKey === undefined || apiKey === '') throw new Error('Muse Code key response is missing api_key');
  return museLoginResult({
    oauthAccessToken: accessToken,
    apiKey,
    email: payload.user_email,
    accountId: payload.user_id,
  });
}

async function postDeviceForm(
  fetcher: RuntimeFetch,
  url: string,
  form: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<Response> {
  return await museControlFetch(fetcher, url, {
    method: 'POST',
    headers: museControlHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: new URLSearchParams(form),
    signal,
  });
}

async function parseJsonObject(response: Response, message: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (isPlainObject(value)) return value;
  } catch {
    // Keep the caller-facing error free of upstream bodies.
  }
  throw new Error(message);
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field !== '' ? field : undefined;
}

function optionalPositiveNumber(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) && field > 0 ? field : undefined;
}

function appendCode(text: LocalizedText, code: string): LocalizedText {
  if (typeof text === 'string') return `${text}\n\n${code}`;
  return Object.fromEntries(
    Object.entries(text).map(([locale, value]) => [locale, `${value}\n\n${code}`]),
  ) as LocalizedText;
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
