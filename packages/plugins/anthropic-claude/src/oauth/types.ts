import type { RuntimeFetch } from '@aio-proxy/plugin-sdk';

export type ClaudeOAuthOptions = {
  readonly fetch?: RuntimeFetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
};
