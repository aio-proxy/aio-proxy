import type { AiSdkProviderInstance, ApiProviderInstance } from "@aio-proxy/core";
import { openDb, requestLog, usage } from "@aio-proxy/core/db";
import { createServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";
import type { CallSettings, JSONValue, TextStreamPart, ToolSet } from "ai";

export { createTempHomes } from "./temporary-homes.test-support";

export const generateRequest = {
  contents: [{ role: "user", parts: [{ text: "Hello proxy" }] }],
};
export const jsonHeaders = { "content-type": "application/json" } as const;
export type ProviderSeenSettings = CallSettings & {
  readonly providerOptions?: {
    readonly google: {
      readonly safetySettings: JSONValue;
    };
  };
};

export async function recorded(home: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const handle = openDb({ home });
    const requests = handle.db.select().from(requestLog).all();
    const usages = handle.db.select().from(usage).all();
    handle.close();
    if (requests.length > 0) return { requests, usages };
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("request row was not recorded");
}

export function textStream(parts: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

export class AbortStreamError extends Error {
  override readonly name = "AbortError";
}

export function appWith(
  provider?: ApiProviderInstance | AiSdkProviderInstance,
  dbHome?: string,
): ReturnType<typeof createServer> {
  return createServer({
    config: { providers: {} },
    ...(dbHome === undefined ? {} : { dbHome }),
    providerInstances: provider === undefined ? [] : [provider],
  });
}

export function googleNativeProvider(passthrough: ApiProviderInstance["passthrough"]): ApiProviderInstance {
  return {
    id: "google",
    kind: "api",
    models: ["gemini-2.5-flash"],
    alias: { "gemini-2.5-flash": { model: "gemini-2.5-flash", preserve: false } },
    protocol: ProviderProtocol.Gemini,
    passthrough,
  };
}

export function aiSdkProvider(invoke: AiSdkProviderInstance["invoke"]): AiSdkProviderInstance {
  return {
    id: "mock-ai",
    kind: "ai-sdk",
    models: ["gemini-2.5-flash"],
    alias: { "gemini-2.5-flash": { model: "gemini-2.5-flash", preserve: false } },
    invoke,
  };
}

export function postGenerate(
  app: ReturnType<typeof createServer>,
  body: string | object = generateRequest,
  model = "gemini-2.5-flash",
): Promise<Response> {
  return app.request(`/v1beta/models/${model}:generateContent`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: jsonHeaders,
    method: "POST",
  });
}

export function postStream(app: ReturnType<typeof createServer>): Promise<Response> {
  return app.request("/v1beta/models/gemini-2.5-flash:streamGenerateContent", {
    body: JSON.stringify(generateRequest),
    headers: jsonHeaders,
    method: "POST",
  });
}
