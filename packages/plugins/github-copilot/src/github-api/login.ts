import type { LocalizedText, OAuthLoginContext } from "@aio-proxy/plugin-sdk";
import { deviceCodeResponseSchema, githubTokenResponseSchema, githubUserResponseSchema } from "../schema";
import { fetchCopilotToken } from "./credential";
import { authHeaders, fetchJson } from "./http";
import type { GitHubAccountOptions, GitHubCopilotCredential, GitHubCopilotLoginPresentationText } from "./types";
import { getGitHubCopilotBaseURL, githubApiBase } from "./urls";

const CLIENT_ID = "Iv1.b507a08c87ecfe98";

export async function loginToGitHubCopilot(
  context: OAuthLoginContext,
  options: GitHubAccountOptions,
  presentationText: GitHubCopilotLoginPresentationText = {
    deviceInstructions: "Enter code",
    refreshingToken: "Refreshing GitHub Copilot token",
    waitingForAuthorization: "Waiting for GitHub authorization",
  },
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
    instructions: appendDeviceCode(presentationText.deviceInstructions, device.userCode),
  });

  const githubToken = await pollGitHubToken(authBase, device, context, presentationText.waitingForAuthorization);
  context.progress(presentationText.refreshingToken);
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
  waitingForAuthorization: LocalizedText,
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
      context.progress(waitingForAuthorization);
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

async function fetchGitHubUser(apiBase: string, githubToken: string, signal: AbortSignal) {
  const body = await fetchJson(
    `${apiBase}/user`,
    { headers: authHeaders(githubToken), signal },
    githubUserResponseSchema,
  );
  return { id: body.id.toString(), login: body.login };
}

function appendDeviceCode(text: LocalizedText, code: string): LocalizedText {
  if (typeof text === "string") return `${text} ${code}`;
  return Object.fromEntries(
    Object.entries(text).map(([locale, value]) => [locale, `${value} ${code}`]),
  ) as LocalizedText;
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
