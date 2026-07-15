import type {
  CredentialPort,
  CredentialSnapshot,
  ModelDescriptor,
  OAuthLoginContext,
  ProtocolId,
  ZodType,
} from "@aio-proxy/plugin-sdk";
import {
  copilotModelSchema,
  copilotTokenResponseSchema,
  deviceCodeResponseSchema,
  githubTokenResponseSchema,
  githubUserResponseSchema,
  modelsResponseSchema,
} from "./schema";

const CLIENT_ID = "Iv1.b507a08c87ecfe98";

export type GitHubAccountOptions =
  | { readonly deploymentType: "github.com" }
  | { readonly deploymentType: "enterprise"; readonly enterpriseURL: string };

export type GitHubCopilotCredential = {
  readonly githubToken: string;
  readonly copilotToken: string;
  readonly expiresAt: number;
  readonly baseURL: string;
  readonly enterpriseURL?: string;
};

export async function loginToGitHubCopilot(
  context: OAuthLoginContext,
  options: GitHubAccountOptions,
): Promise<{
  readonly fingerprint: string;
  readonly suggestedKey: string;
  readonly label?: string;
  readonly credentials: GitHubCopilotCredential;
  readonly expiresAt: number;
}> {
  const enterpriseURL = options.deploymentType === "enterprise" ? options.enterpriseURL : undefined;

  const authBase = enterpriseURL ?? "https://github.com";
  const apiBase = githubApiBase(enterpriseURL);
  const device = await requestDeviceCode(authBase, context.signal);
  await context.authorization.presentDeviceCode({
    url: device.verificationUriComplete ?? device.verificationUri,
    userCode: device.userCode,
    instructions: `Enter code ${device.userCode}`,
  });

  const githubToken = await pollGitHubToken(authBase, device, context);
  context.progress("Refreshing GitHub Copilot token");
  const copilot = await fetchCopilotToken(apiBase, githubToken, context.signal);
  const baseURL = getGitHubCopilotBaseURL(copilot.access, enterpriseURL);
  const user = await fetchGitHubUser(apiBase, githubToken, context.signal);

  return {
    fingerprint: user.id,
    suggestedKey: `copilot-${user.id}`,
    ...(user.login === undefined ? {} : { label: user.login }),
    credentials: {
      githubToken,
      copilotToken: copilot.access,
      expiresAt: copilot.expires,
      baseURL,
      ...(enterpriseURL === undefined ? {} : { enterpriseURL }),
    },
    expiresAt: copilot.expires,
  };
}

export async function discoverGitHubCopilotModels(
  credentials: CredentialPort<GitHubCopilotCredential>,
  signal: AbortSignal,
): Promise<readonly ModelDescriptor[]> {
  const current = await currentGitHubCopilotCredential(credentials);
  const { data } = await fetchJson(
    `${current.baseURL}/models`,
    { headers: copilotHeaders(current.copilotToken), signal },
    modelsResponseSchema,
  );
  return data.flatMap((item) => {
    const model = modelEntry(item);
    return model === undefined ? [] : [model];
  });
}

export async function currentGitHubCopilotCredential(
  credentials: CredentialPort<GitHubCopilotCredential>,
): Promise<GitHubCopilotCredential> {
  const current = await credentials.read();
  if (current.value.expiresAt > Date.now()) return current.value;

  const result = await credentials.refresh(current.revision, refreshGitHubCopilotCredential);
  return result.snapshot.value;
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

async function requestDeviceCode(authBase: string, signal: AbortSignal) {
  return await fetchJson(
    `${authBase}/login/device/code`,
    {
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: "read:user" }),
      headers: { accept: "application/json" },
      method: "POST",
      signal,
    },
    deviceCodeResponseSchema,
  );
}

async function pollGitHubToken(
  authBase: string,
  device: Awaited<ReturnType<typeof requestDeviceCode>>,
  context: OAuthLoginContext,
): Promise<string> {
  let interval = device.interval;
  const deadline = Date.now() + device.expiresIn * 1_000;
  while (Date.now() <= deadline) {
    context.signal.throwIfAborted();
    const body = await fetchJson(
      `${authBase}/login/oauth/access_token`,
      {
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          device_code: device.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        headers: { accept: "application/json" },
        method: "POST",
        signal: context.signal,
      },
      githubTokenResponseSchema,
    );
    if (body.access_token !== undefined) return body.access_token;
    if (body.error === "authorization_pending") {
      context.progress("Waiting for GitHub authorization");
      await abortableSleep(interval * 1_000, context.signal);
      continue;
    }
    if (body.error === "slow_down") {
      interval += 5;
      await abortableSleep(interval * 1_000, context.signal);
      continue;
    }
    throw new Error(body.error ?? "GitHub device authorization failed");
  }
  throw new Error("GitHub device authorization timed out");
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

async function fetchGitHubUser(apiBase: string, githubToken: string, signal: AbortSignal) {
  const body = await fetchJson(
    `${apiBase}/user`,
    { headers: authHeaders(githubToken), signal },
    githubUserResponseSchema,
  );
  return { id: body.id.toString(), login: body.login };
}

async function fetchJson<Output>(url: string, init: RequestInit, schema: ZodType<Output>): Promise<Output> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`GitHub Copilot request failed (${response.status})`);
  return await schema.parseAsync(await response.json());
}

function modelEntry(value: unknown): ModelDescriptor | undefined {
  const result = copilotModelSchema.safeParse(value);
  if (!result.success) return undefined;
  const record = result.data;
  if (record.model_picker_enabled === false || record.capabilities === false) return undefined;
  const protocol = protocolFromEndpoints(record.endpoints);
  if (protocol === undefined) return undefined;
  return {
    id: record.id,
    ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
    metadata: { protocol },
  };
}

function protocolFromEndpoints(endpoints: readonly string[]): ProtocolId | undefined {
  if (endpoints.some((endpoint) => endpoint.includes("/v1/messages"))) return "anthropic";
  if (endpoints.some((endpoint) => endpoint.includes("/responses"))) return "openai-response";
  if (endpoints.some((endpoint) => endpoint.includes("/chat/completions"))) return "openai-compatible";
  return undefined;
}

export function normalizeEnterpriseURL(input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.hostname === "" || url.hostname.includes(" ")) return undefined;
    return `https://${url.hostname}`;
  } catch {
    return undefined;
  }
}

export function getGitHubCopilotBaseURL(token?: string, enterpriseURL?: string): string {
  const proxyEndpoint = token?.match(/(?:^|;)proxy-ep=([^;]+)/)?.[1];
  if (proxyEndpoint !== undefined) {
    const apiEndpoint = proxyEndpoint.startsWith("proxy.")
      ? `api.${proxyEndpoint.slice("proxy.".length)}`
      : proxyEndpoint;
    return `https://${apiEndpoint}`;
  }
  return enterpriseURL ?? "https://api.githubcopilot.com";
}

export function githubApiBase(enterpriseURL: string | undefined): string {
  return enterpriseURL === undefined ? "https://api.github.com" : `${enterpriseURL}/api/v3`;
}

export function copilotHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "User-Agent": "GitHubCopilotChat/0.35.0",
  };
}

function authHeaders(token: string): HeadersInit {
  return { accept: "application/json", authorization: `Bearer ${token}` };
}

function expiresAtMillis(expiresAt: number | undefined, token: string): number {
  const value = expiresAt ?? Number(token.match(/(?:^|;)exp=(\d+)/)?.[1] ?? 0);
  return value > 1_000_000_000_000 ? value : value * 1_000;
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason);
    }
  });
}
