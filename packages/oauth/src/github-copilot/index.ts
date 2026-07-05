import { fetchJson } from "@aio-proxy/core/utils";
import { m } from "@aio-proxy/i18n";
import type {
  OAuthLoginCallbacks,
  OAuthLoginForm,
  OAuthLoginInput,
  OAuthProviderLoginResult,
  OAuthProviderModel,
} from "../oauth-provider";
import { BaseOAuthProvider } from "../oauth-provider";
import {
  type CopilotTransport,
  copilotModelSchema,
  copilotTokenResponseSchema,
  deviceCodeResponseSchema,
  githubTokenResponseSchema,
  githubUserResponseSchema,
  modelsResponseSchema,
} from "./schema";

const CLIENT_ID = "Iv1.b507a08c87ecfe98";

export type GitHubCopilotPayload = {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly enterpriseUrl?: string;
  readonly baseUrl: string;
};

export type GitHubCopilotModel = OAuthProviderModel & {
  readonly transport: CopilotTransport;
};

export class GitHubCopilotOAuthProvider extends BaseOAuthProvider<GitHubCopilotPayload> {
  readonly loginForm = {
    type: "oauth",
    label: m["oauth.github-copilot.login_label"](),
    prompts: [
      {
        type: "select",
        key: "deploymentType",
        message: m["oauth.github-copilot.deployment_type.message"](),
        options: [
          {
            label: m["oauth.github-copilot.deployment_type.options.github.label"](),
            value: "github.com",
            hint: m["oauth.github-copilot.deployment_type.options.github.description"](),
          },
          {
            label: m["oauth.github-copilot.deployment_type.options.github-enterprise.label"](),
            value: "enterprise",
            hint: m["oauth.github-copilot.deployment_type.options.github-enterprise.description"](),
          },
        ],
      },
      {
        type: "text",
        key: "enterpriseUrl",
        message: m["oauth.github-copilot.enterprise_url.message"](),
        placeholder: m["oauth.github-copilot.enterprise_url.placeholder"](),
        when: { key: "deploymentType", op: "eq", value: "enterprise" },
        validate: { required: true, format: "domain-or-url" },
      },
    ],
  } as const satisfies OAuthLoginForm;

  constructor() {
    super("github-copilot", "copilot");
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
    const payload: GitHubCopilotPayload = {
      access: copilot.access,
      refresh: githubToken,
      expires: copilot.expires,
      ...(enterpriseDomain === undefined ? {} : { enterpriseUrl: `https://${enterpriseDomain}` }),
      baseUrl,
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
    return await fetchJson(
      `${authBase}/login/device/code`,
      {
        body: new URLSearchParams({ client_id: CLIENT_ID, scope: "read:user" }),
        headers: { accept: "application/json" },
        method: "POST",
        ...(signal === undefined ? {} : { signal }),
      },
      deviceCodeResponseSchema,
    );
  }

  private async pollGitHubToken(
    authBase: string,
    device: Awaited<ReturnType<GitHubCopilotOAuthProvider["requestDeviceCode"]>>,
    callbacks: OAuthLoginCallbacks,
  ): Promise<string> {
    let interval = device.interval;
    const deadline = Date.now() + device.expiresIn * 1_000;
    while (Date.now() <= deadline) {
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
          ...(callbacks.signal === undefined ? {} : { signal: callbacks.signal }),
        },
        githubTokenResponseSchema,
      );
      if (body.access_token !== undefined) {
        return body.access_token;
      }

      if (body.error === "authorization_pending") {
        callbacks.onProgress?.("Waiting for GitHub authorization");
        await Bun.sleep(interval * 1_000);
        continue;
      }
      if (body.error === "slow_down") {
        interval += 5;
        await Bun.sleep(interval * 1_000);
        continue;
      }
      throw new Error(body.error ?? "GitHub device authorization failed");
    }

    throw new Error("GitHub device authorization timed out");
  }

  private async fetchCopilotToken(apiBase: string, githubToken: string, signal: AbortSignal | undefined) {
    const body = await fetchJson(
      `${apiBase}/copilot_internal/v2/token`,
      {
        headers: authHeaders(githubToken),
        ...(signal === undefined ? {} : { signal }),
      },
      copilotTokenResponseSchema,
    );
    return {
      access: body.token,
      expires: expiresAtMillis(body.expires_at, body.token),
    };
  }

  private async fetchGitHubUser(apiBase: string, githubToken: string, signal: AbortSignal | undefined) {
    const body = await fetchJson(
      `${apiBase}/user`,
      {
        headers: authHeaders(githubToken),
        ...(signal === undefined ? {} : { signal }),
      },
      githubUserResponseSchema,
    );
    return {
      id: body.id.toString(),
      login: body.login,
    };
  }

  private async fetchModels(baseUrl: string, copilotToken: string, signal: AbortSignal | undefined) {
    const { data } = await fetchJson(
      `${baseUrl}/models`,
      {
        headers: copilotHeaders(copilotToken),
        ...(signal === undefined ? {} : { signal }),
      },
      modelsResponseSchema,
    );
    return data.flatMap((item) => {
      const model = modelEntry(item);
      return model === undefined ? [] : [model];
    });
  }

  async models(payload: GitHubCopilotPayload, signal?: AbortSignal): Promise<readonly GitHubCopilotModel[]> {
    const enterpriseDomain =
      payload.enterpriseUrl === undefined ? undefined : (normalizeDomain(payload.enterpriseUrl) ?? undefined);
    const apiBase = enterpriseDomain === undefined ? "https://api.github.com" : `https://${enterpriseDomain}/api/v3`;
    const copilot = await this.fetchCopilotToken(apiBase, payload.refresh, signal);
    return await this.fetchModels(getGitHubCopilotBaseUrl(copilot.access, enterpriseDomain), copilot.access, signal);
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

function modelEntry(value: unknown): GitHubCopilotModel | undefined {
  const result = copilotModelSchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }
  const record = result.data;
  if (record.model_picker_enabled === false) {
    return undefined;
  }
  if (record.capabilities === false) {
    return undefined;
  }
  const transport = transportFromEndpoints(record.endpoints);
  if (transport === undefined) {
    return undefined;
  }
  return {
    alias: record.id,
    id: record.id,
    transport,
  };
}

function transportFromEndpoints(endpoints: readonly string[]): CopilotTransport | undefined {
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
