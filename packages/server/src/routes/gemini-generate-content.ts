import {
  type GeminiGenerateContentSettings,
  GeminiInlineDataTooLargeError,
  geminiGenerateContentToModelMessages,
  parseGeminiGenerateContent,
  Router,
  RouterModelNotFoundError,
  writeGeminiGenerateContentResponse,
  writeGeminiGenerateContentSSE,
} from "@aio-proxy/core";
import type { CallSettings } from "ai";
import { Hono } from "hono";
import { ZodError, z } from "zod";
import type { RuntimeProviderInstance } from "./openai-chat";

const routePrefix = "/v1beta/models/";
const generateSuffix = ":generateContent";
const streamSuffix = ":streamGenerateContent";
const aiSdkGenerationConfigSchema = z
  .object({
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    topP: z.number().optional(),
    topK: z.number().int().positive().optional(),
    stopSequences: z.array(z.string()).optional(),
    seed: z.number().int().optional(),
  })
  .strip();

export function createGeminiGenerateContentRoutes(
  providers: readonly RuntimeProviderInstance[],
) {
  const router = new Router(providers);

  return new Hono().post("/v1beta/models/*", async (context) => {
    const target = routeTarget(new URL(context.req.url).pathname);
    if (target === undefined) {
      return context.text("404 Not Found", 404);
    }

    const route = resolveRoute(router, target.model);
    if (route instanceof Response) {
      return route;
    }

    const provider = route.provider;
    if (
      provider.kind === "api" &&
      provider.protocol === "gemini-generate-content" &&
      provider.vendor === "google-native"
    ) {
      return provider.passthrough(context.req.raw);
    }

    if (provider.kind !== "ai-sdk") {
      return geminiError(
        501,
        "UNIMPLEMENTED",
        "Provider does not support Gemini generateContent transform dispatch",
      );
    }

    const request = await parseRequest(context.req.raw, target.model);
    if (request instanceof Response) {
      return request;
    }

    const transformed = geminiGenerateContentToModelMessages(request);
    const stream = provider.invoke(
      transformed.messages,
      aiSdkSettings(transformed.settings),
      undefined,
      context.req.raw.signal,
    );

    if (target.stream) {
      return new Response(writeGeminiGenerateContentSSE(stream), {
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream; charset=utf-8",
        },
      });
    }

    return Response.json(await writeGeminiGenerateContentResponse(stream));
  });
}

async function parseRequest(
  raw: Request,
  model: string,
): Promise<ReturnType<typeof parseGeminiGenerateContent> | Response> {
  try {
    const body = await raw.clone().json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return parseGeminiGenerateContent(body);
    }

    return parseGeminiGenerateContent({ ...body, model });
  } catch (error) {
    if (error instanceof GeminiInlineDataTooLargeError) {
      return geminiError(413, "RESOURCE_EXHAUSTED", error.message);
    }

    if (error instanceof SyntaxError || error instanceof ZodError) {
      return geminiError(400, "INVALID_ARGUMENT", "Invalid Gemini request");
    }

    throw error;
  }
}

function resolveRoute(router: Router<RuntimeProviderInstance>, model: string) {
  try {
    return router.resolve(model);
  } catch (error) {
    if (error instanceof RouterModelNotFoundError) {
      return geminiError(404, "NOT_FOUND", error.message);
    }

    throw error;
  }
}

function routeTarget(
  pathname: string,
): { readonly model: string; readonly stream: boolean } | undefined {
  if (!pathname.startsWith(routePrefix)) {
    return undefined;
  }

  const value = pathname.slice(routePrefix.length);
  if (value.endsWith(streamSuffix)) {
    const model = decodeURIComponent(value.slice(0, -streamSuffix.length));
    return model === "" ? undefined : { model, stream: true };
  }

  if (value.endsWith(generateSuffix)) {
    const model = decodeURIComponent(value.slice(0, -generateSuffix.length));
    return model === "" ? undefined : { model, stream: false };
  }

  return undefined;
}

function aiSdkSettings(settings: GeminiGenerateContentSettings): CallSettings {
  const parsed = aiSdkGenerationConfigSchema.safeParse(
    settings.generationConfig ?? {},
  );
  if (!parsed.success) {
    return {};
  }

  const config = parsed.data;
  return {
    ...(config.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: config.maxOutputTokens }),
    ...(config.temperature === undefined
      ? {}
      : { temperature: config.temperature }),
    ...(config.topP === undefined ? {} : { topP: config.topP }),
    ...(config.topK === undefined ? {} : { topK: config.topK }),
    ...(config.stopSequences === undefined
      ? {}
      : { stopSequences: config.stopSequences }),
    ...(config.seed === undefined ? {} : { seed: config.seed }),
  };
}

function geminiError(
  code: number,
  status:
    | "INVALID_ARGUMENT"
    | "NOT_FOUND"
    | "RESOURCE_EXHAUSTED"
    | "UNIMPLEMENTED",
  message: string,
): Response {
  return Response.json({ error: { code, message, status } }, { status: code });
}
