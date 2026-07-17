import type { CredentialPort, CredentialSnapshot } from "@aio-proxy/plugin-sdk";
import { copilotTokenResponseSchema } from "../schema";
import { authHeaders, fetchJson } from "./http";
import type { GitHubCopilotCredential } from "./types";
import { getGitHubCopilotBaseURL, githubApiBase } from "./urls";

export async function currentGitHubCopilotCredential(
  credentials: CredentialPort<GitHubCopilotCredential>,
): Promise<GitHubCopilotCredential> {
  const current = await credentials.read();
  if (current.value.expiresAt > Date.now()) return current.value;

  const result = await credentials.refresh(current.revision, refreshGitHubCopilotCredential);
  return result.snapshot.value;
}

export async function fetchCopilotToken(apiBase: string, githubToken: string, signal: AbortSignal) {
  const body = await fetchJson(
    `${apiBase}/copilot_internal/v2/token`,
    { headers: authHeaders(githubToken), signal },
    copilotTokenResponseSchema,
  );
  return {
    access: body.token,
    expires: expiresAtMillis(body.expires_at, body.token),
  };
}

async function refreshGitHubCopilotCredential(
  current: CredentialSnapshot<GitHubCopilotCredential>,
  signal: AbortSignal,
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
