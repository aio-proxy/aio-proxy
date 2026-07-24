import type { CredentialPort, CredentialSnapshot } from "@aio-proxy/plugin-sdk";

import type { GitHubCopilotCredential } from "./types";

import { copilotTokenResponseSchema } from "../schema";
import { authHeaders, fetchJson } from "./http";
import { getGitHubCopilotBaseURL, githubApiBase } from "./urls";

export async function currentGitHubCopilotCredential(
  credentials: CredentialPort<GitHubCopilotCredential>,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<GitHubCopilotCredential> {
  const current = await credentials.read();
  if (current.value.expiresAt > Date.now()) return current.value;

  const result = await credentials.refresh(current.revision, (snapshot, signal) =>
    refreshGitHubCopilotCredential(snapshot, signal, fetcher),
  );
  return result.snapshot.value;
}

export async function fetchCopilotToken(
  apiBase: string,
  githubToken: string,
  signal: AbortSignal,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
) {
  const body = await fetchJson(
    `${apiBase}/copilot_internal/v2/token`,
    { headers: authHeaders(githubToken), signal },
    copilotTokenResponseSchema,
    fetcher,
  );
  return {
    access: body.token,
    expires: expiresAtMillis(body.expires_at, body.token),
  };
}

async function refreshGitHubCopilotCredential(
  current: CredentialSnapshot<GitHubCopilotCredential>,
  signal: AbortSignal,
  fetcher: typeof globalThis.fetch,
): Promise<{
  readonly value: GitHubCopilotCredential;
  readonly metadata: { readonly expiresAt: number };
}> {
  if (current.value.expiresAt > Date.now()) {
    return { value: current.value, metadata: { expiresAt: current.value.expiresAt } };
  }
  const copilot = await fetchCopilotToken(
    githubApiBase(current.value.enterpriseURL),
    current.value.githubToken,
    signal,
    fetcher,
  );
  const value = {
    ...current.value,
    copilotToken: copilot.access,
    expiresAt: copilot.expires,
    baseURL: getGitHubCopilotBaseURL(copilot.access, current.value.enterpriseURL),
  };
  return { value, metadata: { expiresAt: value.expiresAt } };
}

function expiresAtMillis(expiresAt: number | undefined, token: string): number {
  const value = expiresAt ?? Number(token.match(/(?:^|;)exp=(\d+)/)?.[1] ?? 0);
  return value > 1_000_000_000_000 ? value : value * 1_000;
}
