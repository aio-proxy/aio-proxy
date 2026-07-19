import { createOpenAI } from "@ai-sdk/openai";
import type { CredentialPort, OAuthRuntimeResult, RuntimeContext } from "@aio-proxy/plugin-sdk";
import { currentXAIGrokCredential, type XAIGrokFetch, type XAIGrokOAuthOptions } from "./oauth";
import type { XAIGrokCredential } from "./schema";

const BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const CLIENT_VERSION = "0.2.93";

export async function createXAIGrokRuntime(
  context: RuntimeContext<XAIGrokCredential, Record<string, never>>,
  options: XAIGrokOAuthOptions = {},
): Promise<OAuthRuntimeResult> {
  const openai = createOpenAI({
    name: "xai-grok-oauth",
    baseURL: BASE_URL,
    apiKey: "dynamic-credential",
    fetch: createXAIGrokDynamicFetch(context.credentials, options) as typeof globalThis.fetch,
  });
  return {
    provider: {
      specificationVersion: "v4",
      languageModel: (modelId) => openai.responses(modelId),
      embeddingModel: () => unsupported("embedding"),
      imageModel: () => unsupported("image generation"),
    },
  };
}

export function createXAIGrokDynamicFetch(
  credentials: CredentialPort<XAIGrokCredential>,
  options: XAIGrokOAuthOptions = {},
): XAIGrokFetch {
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : options.signal);
    const credential = await currentXAIGrokCredential(credentials, {
      ...options,
      ...(signal === undefined ? {} : { signal }),
    });
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${credential.accessToken}`);
    headers.set("X-XAI-Token-Auth", "xai-grok-cli");
    headers.set("x-grok-client-version", CLIENT_VERSION);
    headers.set("User-Agent", `xai-grok-workspace/${CLIENT_VERSION}`);
    headers.delete("content-length");
    const body = await outgoingBody(request);
    return await (options.fetch ?? globalThis.fetch)(request.url, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
      redirect: request.redirect,
    });
  };
}

function unsupported(surface: string): never {
  throw new Error(`xAI Grok OAuth does not support ${surface}`);
}

async function outgoingBody(request: Request): Promise<BodyInit | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const original = new Uint8Array(await request.arrayBuffer());
  if (!new URL(request.url).pathname.endsWith("/responses")) return original;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(original));
    if (typeof value !== "object" || value === null) return original;
    const reasoning = Reflect.get(value, "reasoning");
    if (typeof reasoning !== "object" || reasoning === null || !Reflect.has(reasoning, "summary")) return original;
    Reflect.deleteProperty(reasoning, "summary");
    return JSON.stringify(value);
  } catch {
    return original;
  }
}
