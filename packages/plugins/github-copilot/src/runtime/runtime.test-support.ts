import type { ModelCatalog } from '@aio-proxy/plugin-sdk';

import type { GitHubAccountOptions, GitHubCopilotCredential } from '..';

export function catalog(): ModelCatalog {
  return {
    language: [
      { id: 'gpt-chat', extra: { protocol: 'openai-compatible' } },
      { id: 'claude', extra: { protocol: 'anthropic' } },
      { id: 'gpt-response', extra: { protocol: 'openai-response' } },
    ],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}

export function validCredential(copilotToken: string): GitHubCopilotCredential {
  return {
    githubToken: 'github-token',
    copilotToken,
    expiresAt: Date.now() + 60_000,
    baseURL: 'https://api.githubcopilot.com',
  };
}

const _optionsCompile: GitHubAccountOptions = { deploymentType: 'github.com' };
void _optionsCompile;

export const forwardFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
