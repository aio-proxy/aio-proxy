import type { OAuthLoginCallbacks, OAuthLoginForm, OAuthLoginInput, OAuthProviderLoginResult } from "./oauth-provider";
import { BaseOAuthProvider } from "./oauth-provider";

const CLIENT_ID = "Iv1.b507a08c87ecfe98";

type CopilotTransport = "chat" | "messages" | "responses";

export type GitHubCopilotPayload = {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly enterpriseUrl?: string;
  readonly baseUrl: string;
  readonly models: readonly {
    readonly alias: string;
    readonly id: string;
    readonly transport: CopilotTransport;
  }[];
  readonly syncedAt: number;
};

type GitHubCopilotOAuthProviderOptions = {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export class GitHubCopilotOAuthProvider extends BaseOAuthProvider<GitHubCopilotPayload> {
  readonly loginForm = {
    type: "oauth",
    label: "Login with GitHub Copilot",
    prompts: [
      {
        type: "select",
        key: "deploymentType",
        message: "Select GitHub deployment type",
        options: [
          { label: "GitHub.com", value: "github.com", hint: "Public" },
          { label: "GitHub Enterprise", value: "enterprise", hint: "Data residency or self-hosted" },
        ],
      },
      {
        type: "text",
        key: "enterpriseUrl",
        message: "Enter your GitHub Enterprise URL or domain",
        placeholder: "company.ghe.com or https://company.ghe.com",
        when: { key: "deploymentType", op: "eq", value: "enterprise" },
        validate: { required: true, format: "domain-or-url" },
      },
    ],
  } as const satisfies OAuthLoginForm;

  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GitHubCopilotOAuthProviderOptions = {}) {
    super("github-copilot", "copilot");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async login(
    input: OAuthLoginInput,
    callbacks: OAuthLoginCallbacks,
  ): Promise<OAuthProviderLoginResult<GitHubCopilotPayload>> {
    const deploymentType = input.deploymentType ?? "github.com";
    const enterpriseDomain = deploymentType === "enterprise" ? normalizeDomain(input.enterpriseUrl ?? "") : undefined;
    if (deploymentType === "enterprise" && enterpriseDomain === null) {
      throw new Error("GitHub Enterprise URL or domain is required");
    }

    const authBase = enterpriseDomain === undefined ? "https://github.com" : `https://${enterpriseDomain}`;
    const apiBase = enterpriseDomain === undefined ? "https://api.github.com" : `${authBase}/api/v3`;
    const device = await this.requestDeviceCode(authBase, callbacks.signal);
    callbacks.onAuth({
      url: device.verificationUriComplete ?? device.verificationUri,
      instructions: `Enter code ${device.userCode}`,
      userCode: device.userCode,
    });

    const githubToken = await this.pollGitHubToken(authBase, device, callbacks);
    callbacks.onProgress?.("Refreshing GitHub Copilot token");
    const copilot = await this.fetchCopilotToken(apiBase, githubToken, callbacks.signal);
    const baseUrl = getGitHubCopilotBaseUrl(copilot.access, enterpriseDomain ?? undefined);
    const user = await this.fetchGitHubUser(apiBase, githubToken, callbacks.signal);
    const models = await this.fetchModels(baseUrl, copilot.access, callbacks.signal);
    const payload: GitHubCopilotPayload = {
      access: copilot.access,
      refresh: githubToken,
      expires: copilot.expires,
      ...(enterpriseDomain === undefined ? {} : { enterpriseUrl: `https://${enterpriseDomain}` }),
      baseUrl,
      models,
      syncedAt: this.now(),
    };
    const providerId = this.providerId(user.id);
    this.store(providerId, payload, user.login);

    return {
      ...(user.login === undefined ? {} : { accountLabel: user.login }),
      payload,
      providerId,
      status: "authenticated",
      userId: user.id,
    };
  }

  private async requestDeviceCode(authBase: string, signal: AbortSignal | undefined) {
    const json = await fetchJson(
      this.fetch,
      `${authBase}/login/device/code`,
      withSignal(
        {
          body: new URLSearchParams({ client_id: CLIENT_ID, scope: "read:user" }),
          headers: { accept: "application/json" },
          method: "POST",
        },
        signal,
      ),
    );

    return {
      deviceCode: readString(json, "device_code"),
      userCode: readString(json, "user_code"),
      verificationUri: readString(json, "verification_uri"),
      verificationUriComplete: readOptionalString(json, "verification_uri_complete"),
      interval: readNumber(json, "interval") ?? 5,
      expiresIn: readNumber(json, "expires_in") ?? 900,
    };
  }

  private async pollGitHubToken(
    authBase: string,
    device: Awaited<ReturnType<GitHubCopilotOAuthProvider["requestDeviceCode"]>>,
    callbacks: OAuthLoginCallbacks,
  ): Promise<string> {
    let interval = device.interval;
    const deadline = this.now() + device.expiresIn * 1_000;
    while (this.now() <= deadline) {
      const json = await fetchJson(
        this.fetch,
        `${authBase}/login/oauth/access_token`,
        withSignal(
          {
            body: new URLSearchParams({
              client_id: CLIENT_ID,
              device_code: device.deviceCode,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
            headers: { accept: "application/json" },
            method: "POST",
          },
          callbacks.signal,
        ),
      );
      const accessToken = readOptionalString(json, "access_token");
      if (accessToken !== undefined) {
        return accessToken;
      }

      const error = readOptionalString(json, "error");
      if (error === "authorization_pending") {
        callbacks.onProgress?.("Waiting for GitHub authorization");
        await this.sleep(interval * 1_000);
        continue;
      }
      if (error === "slow_down") {
        interval += 5;
        await this.sleep(interval * 1_000);
        continue;
      }
      throw new Error(error ?? "GitHub device authorization failed");
    }

    throw new Error("GitHub device authorization timed out");
  }

  private async fetchCopilotToken(apiBase: string, githubToken: string, signal: AbortSignal | undefined) {
    const json = await fetchJson(
      this.fetch,
      `${apiBase}/copilot_internal/v2/token`,
      withSignal({ headers: authHeaders(githubToken) }, signal),
    );
    const access = readString(json, "token");
    return {
      access,
      expires: expiresAtMillis(readNumber(json, "expires_at"), access),
    };
  }

  private async fetchGitHubUser(apiBase: string, githubToken: string, signal: AbortSignal | undefined) {
    const json = await fetchJson(
      this.fetch,
      `${apiBase}/user`,
      withSignal({ headers: authHeaders(githubToken) }, signal),
    );
    const id = readNumber(json, "id")?.toString() ?? readString(json, "id");
    return {
      id,
      login: readOptionalString(json, "login"),
    };
  }

  private async fetchModels(baseUrl: string, copilotToken: string, signal: AbortSignal | undefined) {
    const json = await fetchJson(
      this.fetch,
      `${baseUrl}/models`,
      withSignal({ headers: copilotHeaders(copilotToken) }, signal),
    );
    const data = readArray(json, "data");
    const models: GitHubCopilotPayload["models"][number][] = [];
    for (const item of data) {
      const model = modelEntry(item);
      if (model === undefined) {
        continue;
      }
      const policy = await this.fetch(`${baseUrl}/models/${encodeURIComponent(model.id)}/policy`, {
        headers: copilotHeaders(copilotToken),
        ...(signal === undefined ? {} : { signal }),
      });
      if (policy.ok) {
        models.push(model);
      }
    }
    return models;
  }
}

export const githubCopilotOAuthProvider = new GitHubCopilotOAuthProvider();

export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname === "" || url.hostname.includes(" ") ? null : url.hostname;
  } catch {
    return null;
  }
}

export function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
  const proxyEndpoint = token?.match(/(?:^|;)proxy-ep=([^;]+)/)?.[1];
  if (proxyEndpoint !== undefined) {
    const apiEndpoint = proxyEndpoint.startsWith("proxy.")
      ? `api.${proxyEndpoint.slice("proxy.".length)}`
      : proxyEndpoint;
    return `https://${apiEndpoint}`;
  }

  if (enterpriseDomain !== undefined) {
    return `https://${enterpriseDomain}`;
  }

  return "https://api.githubcopilot.com";
}

function modelEntry(value: unknown): GitHubCopilotPayload["models"][number] | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Partial<CopilotModelRecord>;
  if (record.model_picker_enabled === false) {
    return undefined;
  }
  const capabilities = record.capabilities;
  if (Array.isArray(capabilities) && !capabilities.includes("chat")) {
    return undefined;
  }
  const rawId = record.id;
  const id = typeof rawId === "string" ? rawId : undefined;
  if (id === undefined) {
    return undefined;
  }
  const transport = transportFromEndpoints(record.endpoints);
  if (transport === undefined) {
    return undefined;
  }
  return {
    alias: typeof record.name === "string" ? record.name : id,
    id,
    transport,
  };
}

type CopilotModelRecord = {
  readonly capabilities: unknown;
  readonly endpoints: unknown;
  readonly id: unknown;
  readonly model_picker_enabled: unknown;
  readonly name: unknown;
};

function transportFromEndpoints(value: unknown): CopilotTransport | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const endpoints = value.map((endpoint) => (typeof endpoint === "string" ? endpoint : JSON.stringify(endpoint)));
  if (endpoints.some((endpoint) => endpoint.includes("/v1/messages"))) {
    return "messages";
  }
  if (endpoints.some((endpoint) => endpoint.includes("/responses"))) {
    return "responses";
  }
  if (endpoints.some((endpoint) => endpoint.includes("/chat/completions"))) {
    return "chat";
  }
  return undefined;
}

async function fetchJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init);
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`GitHub Copilot request failed: ${response.status}`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("GitHub Copilot response was not an object");
  }
  return json as Record<string, unknown>;
}

function withSignal(init: RequestInit, signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? init : { ...init, signal };
}

function authHeaders(token: string): HeadersInit {
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
  };
}

function copilotHeaders(token: string): HeadersInit {
  return {
    ...authHeaders(token),
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "User-Agent": "GitHubCopilotChat/0.35.0",
  };
}

function expiresAtMillis(expiresAt: number | undefined, token: string): number {
  const value = expiresAt ?? Number(token.match(/(?:^|;)exp=(\d+)/)?.[1] ?? 0);
  return value > 1_000_000_000_000 ? value : value * 1_000;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    throw new Error(`GitHub Copilot response missing ${key}`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function readArray(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}
