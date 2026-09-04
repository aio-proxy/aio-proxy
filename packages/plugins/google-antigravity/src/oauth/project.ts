import { isPlainObject } from 'es-toolkit/predicate';

import { antigravityEndpoints } from '../runtime/endpoints';
import { antigravityOnboardingUserAgent, antigravityUserAgent } from '../runtime/hub-version';
import type { GoogleAntigravityAccountOptions } from '../schema';

const API_VERSION = 'v1internal';
const FREE_TIER_ID = 'free-tier';
const ONBOARD_TIMEOUT_MS = 30_000;
const ONBOARD_POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const LOAD_METADATA = { ideType: 'ANTIGRAVITY' } as const;

export type ProjectInitializationDependencies = {
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => number) | undefined;
};

export async function initializeAntigravityProject(
  accessToken: string,
  options: GoogleAntigravityAccountOptions,
  dependencies: ProjectInitializationDependencies = {},
): Promise<string> {
  if (accessToken.trim() === '') throw new Error('Google Antigravity project initialization requires an access token');
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? Bun.sleep;
  const now = dependencies.now ?? Date.now;
  const daily = antigravityEndpoints(options, 'project-load')[0] ?? '';
  if (daily === '') throw new Error('Google Antigravity project load endpoint is missing');
  const userAgent = antigravityUserAgent();

  const initial = await loadCodeAssist(fetchImpl, daily, accessToken, {}, dependencies.signal, userAgent);
  assertFreeTierEligible(initial);
  if (!hasTier(initial, 'currentTier')) {
    await onboardUser(fetchImpl, daily, accessToken, sleep, now, dependencies.signal, antigravityOnboardingUserAgent());
  }

  const refreshed = await loadCodeAssist(fetchImpl, daily, accessToken, {}, dependencies.signal, userAgent);
  const projectId = extractProjectId(refreshed);
  if (projectId === undefined) {
    throw new Error('Google Antigravity project onboarding did not return a project id');
  }
  return projectId;
}

async function loadCodeAssist(
  fetchImpl: typeof globalThis.fetch,
  daily: string,
  accessToken: string,
  extra: Record<string, unknown>,
  signal: AbortSignal | undefined,
  userAgent: string,
): Promise<Record<string, unknown>> {
  let payload = await requestJson(fetchImpl, `${daily}/${API_VERSION}:loadCodeAssist`, {
    accessToken,
    method: 'POST',
    body: { ...extra, metadata: LOAD_METADATA },
    signal: combinedTimeoutSignal(signal),
    userAgent,
    operation: 'project load',
  });
  const projectId = extractProjectId(payload);
  if (projectId !== undefined && !hasTier(payload, 'paidTier')) {
    payload = await requestJson(fetchImpl, `${daily}/${API_VERSION}:loadCodeAssist`, {
      accessToken,
      method: 'POST',
      body: { cloudaicompanionProject: projectId, metadata: LOAD_METADATA },
      signal: combinedTimeoutSignal(signal),
      userAgent,
      operation: 'project load',
    });
  }
  return payload;
}

async function onboardUser(
  fetchImpl: typeof globalThis.fetch,
  daily: string,
  accessToken: string,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => number,
  signal: AbortSignal | undefined,
  userAgent: string,
): Promise<void> {
  const deadline = now() + ONBOARD_TIMEOUT_MS;
  let operation = await requestJson(fetchImpl, `${daily}/${API_VERSION}:onboardUser`, {
    accessToken,
    method: 'POST',
    body: { tierId: FREE_TIER_ID, metadata: LOAD_METADATA },
    signal: combinedTimeoutSignal(signal, remainingOnboardTime(deadline, now)),
    userAgent,
    operation: 'project onboarding',
  });

  while (Reflect.get(operation, 'done') !== true) {
    const remaining = remainingOnboardTime(deadline, now);
    await sleep(Math.min(ONBOARD_POLL_INTERVAL_MS, remaining));
    const name = trimmedString(Reflect.get(operation, 'name'));
    if (name === undefined) {
      throw new Error('Google Antigravity project onboarding returned an operation without a name');
    }
    operation = await requestJson(fetchImpl, `${daily}/${API_VERSION}/${name}`, {
      accessToken,
      method: 'GET',
      signal: combinedTimeoutSignal(signal, remainingOnboardTime(deadline, now)),
      userAgent,
      operation: 'project onboarding',
    });
  }

  const error = Reflect.get(operation, 'error');
  if (isPlainObject(error)) {
    const message = trimmedString(Reflect.get(error, 'message')) ?? 'Google Antigravity project onboarding failed';
    throw new Error(message);
  }
}

function remainingOnboardTime(deadline: number, now: () => number): number {
  const remaining = deadline - now();
  if (remaining > 0) return remaining;
  throw new Error(`Google Antigravity project onboarding timed out after ${ONBOARD_TIMEOUT_MS}ms`);
}

function assertFreeTierEligible(payload: Record<string, unknown>): void {
  const allowed = payload['allowedTiers'];
  if (
    Array.isArray(allowed) &&
    allowed.some((tier) => isPlainObject(tier) && Reflect.get(tier, 'id') === FREE_TIER_ID)
  ) {
    return;
  }
  const ineligible = payload['ineligibleTiers'];
  if (!Array.isArray(ineligible)) return;
  for (const tier of ineligible) {
    if (!isPlainObject(tier) || Reflect.get(tier, 'tierId') !== FREE_TIER_ID) continue;
    const reason = trimmedString(Reflect.get(tier, 'reasonMessage'));
    if (reason === undefined) continue;
    const validationUrl = trimmedString(Reflect.get(tier, 'validationUrl'));
    throw new Error(validationUrl === undefined ? reason : `${reason}\n${validationUrl}`);
  }
}

async function requestJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  input: {
    readonly accessToken: string;
    readonly method: 'GET' | 'POST';
    readonly body?: unknown;
    readonly signal?: AbortSignal;
    readonly userAgent: string;
    readonly operation: string;
  },
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: input.method,
      headers: {
        Accept: '*/*',
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': input.userAgent,
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    throw new Error(`Google Antigravity ${input.operation} failed`);
  }
  if (!response.ok) throw new Error(`Google Antigravity ${input.operation} failed (HTTP ${response.status})`);
  try {
    const payload: unknown = await response.json();
    if (!isPlainObject(payload)) throw new Error();
    return payload;
  } catch {
    throw new Error(`Google Antigravity ${input.operation} returned an invalid response`);
  }
}

function extractProjectId(payload: unknown): string | undefined {
  if (!isPlainObject(payload)) return undefined;
  for (const key of ['cloudaicompanionProject', 'projectId', 'project'] as const) {
    const value = Reflect.get(payload, key);
    const direct = trimmedString(value);
    if (direct !== undefined) return direct;
    if (isPlainObject(value)) {
      const nested = trimmedString(Reflect.get(value, 'id'));
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function hasTier(payload: Record<string, unknown>, field: 'currentTier' | 'paidTier'): boolean {
  const value = payload[field];
  return value !== undefined && value !== null;
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.trim();
}

function combinedTimeoutSignal(signal: AbortSignal | undefined, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}
