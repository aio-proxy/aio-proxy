import type { RuntimeFetch, RuntimeRequestInit, ZodType } from '@aio-proxy/plugin-sdk';

export async function fetchJson<Output>(
  url: string,
  init: RuntimeRequestInit,
  schema: ZodType<Output>,
  fetcher: RuntimeFetch = globalThis.fetch,
): Promise<Output> {
  const response = await fetcher(url, init);
  if (!response.ok) throw new Error(`GitHub Copilot request failed (${response.status})`);
  return await schema.parseAsync(await response.json());
}

// One editor identity for the whole plugin. `runtime/host-fetch.test.ts` pins these on the model
// path, so a bump has to move both builders together.
const EDITOR_VERSION = 'vscode/1.107.0';
const EDITOR_PLUGIN_VERSION = 'copilot-chat/0.35.0';
const EDITOR_USER_AGENT = 'GitHubCopilotChat/0.35.0';
const GITHUB_API_VERSION = '2025-04-01';

export function copilotHeaders(token: string): HeadersInit {
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'Copilot-Integration-Id': 'vscode-chat',
    'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
    'Editor-Version': EDITOR_VERSION,
    'User-Agent': EDITOR_USER_AGENT,
  };
}

/** GitHub REST (`api.github.com`, `<enterprise>/api/v3`) authenticates the GitHub OAuth token as `token`. */
export function githubUserHeaders(githubToken: string): HeadersInit {
  return {
    accept: 'application/json',
    authorization: `token ${githubToken}`,
    'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
    'Editor-Version': EDITOR_VERSION,
    'User-Agent': EDITOR_USER_AGENT,
    'X-Github-Api-Version': GITHUB_API_VERSION,
  };
}

export function authHeaders(token: string): HeadersInit {
  return { accept: 'application/json', authorization: `Bearer ${token}` };
}
