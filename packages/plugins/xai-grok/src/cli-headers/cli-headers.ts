import type { XAIGrokCredential } from '../schema';

export const XAI_GROK_CLI_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
// cli-chat-proxy answers outdated client versions with 426 Upgrade Required; track the shipping Grok Build.
export const XAI_GROK_CLI_CLIENT_VERSION = '1.0.50';

export function createXAIGrokCLIHeaders(credential: XAIGrokCredential, init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set('authorization', `Bearer ${credential.accessToken}`);
  headers.set('x-xai-token-auth', 'xai-grok-cli');
  headers.set('x-grok-client-version', XAI_GROK_CLI_CLIENT_VERSION);
  headers.set('x-grok-client-identifier', 'grok-shell');
  headers.set('x-grok-client-mode', 'headless');
  headers.set('x-authenticateresponse', 'authenticate-response');
  headers.set('user-agent', `grok-shell/${XAI_GROK_CLI_CLIENT_VERSION}`);
  return headers;
}
