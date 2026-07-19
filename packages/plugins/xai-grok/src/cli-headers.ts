import type { XAIGrokCredential } from "./schema";

export const XAI_GROK_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const XAI_GROK_CLI_CLIENT_VERSION = "0.2.93";

export function createXAIGrokCLIHeaders(credential: XAIGrokCredential, init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("authorization", `Bearer ${credential.accessToken}`);
  headers.set("x-xai-token-auth", "xai-grok-cli");
  headers.set("x-grok-client-version", XAI_GROK_CLI_CLIENT_VERSION);
  headers.set("user-agent", `xai-grok-workspace/${XAI_GROK_CLI_CLIENT_VERSION}`);
  return headers;
}
