import type { GoogleAntigravityAccountOptions } from "../schema";

import { antigravityEndpoints } from "../runtime/endpoints";
import {
  ANTIGRAVITY_GOOGLE_API_CLIENT,
  antigravityOnboardingUserAgent,
  antigravityUserAgent,
  hubVersion,
} from "../runtime/hub-version";

const API_VERSION = "v1internal";
const ONBOARD_ATTEMPTS = 5;
const ONBOARD_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;

export type ProjectInitializationDependencies = {
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly signal?: AbortSignal | undefined;
};

export async function initializeAntigravityProject(
  accessToken: string,
  options: GoogleAntigravityAccountOptions,
  dependencies: ProjectInitializationDependencies = {},
): Promise<string> {
  if (accessToken.trim() === "") throw new Error("Google Antigravity project initialization requires an access token");
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const loadResponse = await requestJson(
    fetchImpl,
    `${antigravityEndpoints(options, "project-load")[0]}/${API_VERSION}:loadCodeAssist`,
    {
      accessToken,
      body: { metadata: { ideType: "ANTIGRAVITY" } },
      signal: combinedTimeoutSignal(dependencies.signal),
      userAgent: antigravityUserAgent(),
      operation: "project load",
    },
  );
  const existingProject = extractProjectId(loadResponse);
  if (existingProject !== undefined) return existingProject;

  const tierId = selectTier(loadResponse);
  const sleep = dependencies.sleep ?? Bun.sleep;
  for (let attempt = 0; attempt < ONBOARD_ATTEMPTS; attempt += 1) {
    const onboardResponse = await requestJson(
      fetchImpl,
      `${antigravityEndpoints(options, "onboarding")[0]}/${API_VERSION}:onboardUser`,
      {
        accessToken,
        body: {
          tier_id: tierId,
          metadata: { ide_type: "ANTIGRAVITY", ide_version: hubVersion(), ide_name: "antigravity" },
        },
        signal: combinedTimeoutSignal(dependencies.signal),
        userAgent: antigravityOnboardingUserAgent(),
        googleApiClient: ANTIGRAVITY_GOOGLE_API_CLIENT,
        operation: "project onboarding",
      },
    );
    if (Reflect.get(onboardResponse, "done") === true) {
      const projectId = extractProjectId(Reflect.get(onboardResponse, "response"));
      if (projectId !== undefined) return projectId;
    }
    if (attempt + 1 < ONBOARD_ATTEMPTS) await sleep(ONBOARD_INTERVAL_MS);
  }
  throw new Error("Google Antigravity project onboarding did not complete after five attempts");
}

async function requestJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  input: {
    readonly accessToken: string;
    readonly body: unknown;
    readonly signal?: AbortSignal;
    readonly userAgent: string;
    readonly googleApiClient?: string;
    readonly operation: string;
  },
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "*/*",
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": input.userAgent,
        ...(input.googleApiClient === undefined ? {} : { "X-Goog-Api-Client": input.googleApiClient }),
      },
      body: JSON.stringify(input.body),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    throw new Error(`Google Antigravity ${input.operation} failed`);
  }
  if (!response.ok) throw new Error(`Google Antigravity ${input.operation} failed (HTTP ${response.status})`);
  try {
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error();
    return payload as Record<string, unknown>;
  } catch {
    throw new Error(`Google Antigravity ${input.operation} returned an invalid response`);
  }
}

function extractProjectId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  for (const key of ["cloudaicompanionProject", "projectId", "project"] as const) {
    const value = Reflect.get(payload, key);
    const direct = trimmedString(value);
    if (direct !== undefined) return direct;
    if (typeof value === "object" && value !== null) {
      const nested = trimmedString(Reflect.get(value, "id"));
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function selectTier(payload: Record<string, unknown>): string {
  const tiers = payload["allowedTiers"];
  if (Array.isArray(tiers)) {
    for (const tier of tiers) {
      if (typeof tier === "object" && tier !== null && Reflect.get(tier, "isDefault") === true) {
        const id = trimmedString(Reflect.get(tier, "id"));
        if (id !== undefined) return id;
      }
    }
  }
  const currentTier = payload["currentTier"];
  if (typeof currentTier === "object" && currentTier !== null) {
    const id = trimmedString(Reflect.get(currentTier, "id"));
    if (id !== undefined) return id;
  }
  return "free-tier";
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}

function combinedTimeoutSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}
