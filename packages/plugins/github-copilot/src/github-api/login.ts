import type { LocalizedText, OAuthLoginContext, RuntimeFetch } from '@aio-proxy/plugin-sdk';

import {
  deviceCodeResponseSchema,
  githubEmailsResponseSchema,
  githubTokenResponseSchema,
  githubUserResponseSchema,
} from '../schema';
import { fetchCopilotToken } from './credential';
import { authHeaders, fetchJson } from './http';
import type { GitHubAccountOptions, GitHubCopilotCredential, GitHubCopilotLoginPresentationText } from './types';
import { getGitHubCopilotBaseURL, githubApiBase } from './urls';

declare const __AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__: string;

const CLIENT_ID = __AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__;

export async function loginToGitHubCopilot(
  context: OAuthLoginContext,
  options: GitHubAccountOptions,
  presentationText: GitHubCopilotLoginPresentationText = {
    deviceInstructions: 'Enter code',
    refreshingToken: 'Refreshing GitHub Copilot token',
    waitingForAuthorization: 'Waiting for GitHub authorization',
  },
): Promise<{
  readonly fingerprint: string;
  readonly suggestedKey: string;
  readonly accountLabel?: string;
  readonly credentials: GitHubCopilotCredential;
  readonly expiresAt: number;
}> {
  const enterpriseURL = options.deploymentType === 'enterprise' ? options.enterpriseURL : undefined;
  const authBase = enterpriseURL ?? 'https://github.com';
  const apiBase = githubApiBase(enterpriseURL);
  const fetcher = context.fetch ?? globalThis.fetch;
  const device = await requestDeviceCode(authBase, context.signal, fetcher);
  await context.authorization.presentDeviceCode({
    url: device.verificationUriComplete ?? device.verificationUri,
    userCode: device.userCode,
    instructions: appendDeviceCode(presentationText.deviceInstructions, device.userCode),
  });

  const githubToken = await pollGitHubToken(authBase, device, context, presentationText.waitingForAuthorization);
  context.progress(presentationText.refreshingToken);
  const copilot = await fetchCopilotToken(apiBase, githubToken, context.signal, fetcher);
  const baseURL = getGitHubCopilotBaseURL(copilot.access, enterpriseURL);
  const user = await fetchGitHubUser(apiBase, githubToken, context.signal, fetcher);
  const email = await fetchGitHubPrimaryEmail(apiBase, githubToken, context.signal, fetcher);
  const accountLabel = email ?? user.login;

  return {
    fingerprint: user.id,
    suggestedKey: `copilot-${user.id}`,
    ...(accountLabel === undefined ? {} : { accountLabel }),
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

async function requestDeviceCode(authBase: string, signal: AbortSignal, fetcher: RuntimeFetch) {
  return await fetchJson(
    `${authBase}/login/device/code`,
    {
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'read:user user:email' }),
      headers: { accept: 'application/json' },
      method: 'POST',
      signal,
    },
    deviceCodeResponseSchema,
    fetcher,
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
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        headers: { accept: 'application/json' },
        method: 'POST',
        signal: context.signal,
      },
      githubTokenResponseSchema,
      context.fetch,
    );
    if (body.access_token !== undefined) return body.access_token;
    if (body.error === 'authorization_pending') {
      context.progress(waitingForAuthorization);
      await abortableSleep(interval * 1_000, context.signal);
      continue;
    }
    if (body.error === 'slow_down') {
      interval += 5;
      await abortableSleep(interval * 1_000, context.signal);
      continue;
    }
    throw new Error(body.error ?? 'GitHub device authorization failed');
  }
  throw new Error('GitHub device authorization timed out');
}

async function fetchGitHubUser(apiBase: string, githubToken: string, signal: AbortSignal, fetcher: RuntimeFetch) {
  const body = await fetchJson(
    `${apiBase}/user`,
    { headers: authHeaders(githubToken), signal },
    githubUserResponseSchema,
    fetcher,
  );
  return { id: body.id.toString(), login: body.login };
}

function appendDeviceCode(text: LocalizedText, code: string): LocalizedText {
  if (typeof text === 'string') return `${text} ${code}`;
  return Object.fromEntries(
    Object.entries(text).map(([locale, value]) => [locale, `${value} ${code}`]),
  ) as LocalizedText;
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', aborted, { once: true });
    function done() {
      signal.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason);
    }
  });
}

async function fetchGitHubPrimaryEmail(
  apiBase: string,
  githubToken: string,
  signal: AbortSignal,
  fetcher: RuntimeFetch,
): Promise<string | undefined> {
  try {
    const emails = await fetchJson(
      `${apiBase}/user/emails`,
      { headers: authHeaders(githubToken), signal },
      githubEmailsResponseSchema,
      fetcher,
    );
    const match = emails.find((entry) => entry.primary === true && entry.verified === true);
    const email = match?.email.trim().toLowerCase();
    return email === undefined || email === '' ? undefined : email;
  } catch {
    return undefined;
  }
}
