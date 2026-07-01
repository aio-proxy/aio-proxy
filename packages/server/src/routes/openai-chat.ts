import {
  type AiSdkProviderInstance,
  type ApiProviderInstance,
  openaiChatToModelMessages,
  parseOpenAIChat,
  Router,
  RouterModelNotFoundError,
  toIngressError,
  writeOpenAIChatCompletion,
  writeOpenAIChatSSE,
} from "@aio-proxy/core";
import { Hono } from "hono";
import { ZodError } from "zod";

export type RuntimeProviderInstance =
  | ApiProviderInstance
  | AiSdkProviderInstance;

const maxBodyBytes = 8 * 1_024 * 1_024;

export function createOpenAIChatRoutes(
  providers: readonly RuntimeProviderInstance[],
) {
  const router = new Router(providers);

  return new Hono().post("/v1/chat/completions", async (context) => {
    const contentLength = context.req.header("content-length");
    if (
      contentLength !== undefined &&
      Number.parseInt(contentLength, 10) > maxBodyBytes
    ) {
      return openAIError(413, "request_too_large", "Request body too large");
    }

    const request = await parseRequest(context.req.raw);
    if (request instanceof Response) {
      return request;
    }

    const route = resolveRoute(router, request.model);
    if (route instanceof Response) {
      return route;
    }

    const provider = route.provider;
    if (
      provider.kind === "api" &&
      provider.protocol === "openai-chat" &&
      provider.vendor === "openai-native"
    ) {
      return provider.passthrough(context.req.raw);
    }

    if (provider.kind !== "ai-sdk") {
      return openAIError(
        501,
        "not_implemented",
        "Provider does not support OpenAI Chat transform dispatch",
      );
    }

    const transformed = openaiChatToModelMessages(request);

    if (request.stream === false) {
      try {
        const stream = provider.invoke({
          messages: transformed.messages,
          modelId: route.modelId,
          settings: transformed.settings,
          signal: context.req.raw.signal,
        });
        return Response.json(await writeOpenAIChatCompletion(stream));
      } catch (error) {
        // no-excuse-ok: catch - HTTP boundary converts provider failures.
        const ingressError = toIngressError(error, "openai-chat");
        return Response.json(ingressError.body, {
          status: ingressError.status,
        });
      }
    }

    try {
      if (
        "ensureAvailable" in provider &&
        typeof provider.ensureAvailable === "function"
      ) {
        await provider.ensureAvailable();
      }
      const stream = provider.invoke({
        messages: transformed.messages,
        modelId: route.modelId,
        settings: transformed.settings,
        signal: context.req.raw.signal,
      });

      return new Response(writeOpenAIChatSSE(stream), {
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream; charset=utf-8",
        },
      });
    } catch (error) {
      // no-excuse-ok: catch - HTTP boundary converts provider failures.
      const ingressError = toIngressError(error, "openai-chat");
      return Response.json(ingressError.body, {
        status: ingressError.status,
      });
    }
  });
}

async function parseRequest(
  raw: Request,
): Promise<ReturnType<typeof parseOpenAIChat> | Response> {
  try {
    return parseOpenAIChat(await raw.clone().json());
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) {
      return openAIError(400, "invalid_request", "Invalid OpenAI Chat request");
    }

    throw error;
  }
}

function resolveRoute(router: Router<RuntimeProviderInstance>, model: string) {
  try {
    return router.resolve(model);
  } catch (error) {
    if (error instanceof RouterModelNotFoundError) {
      return openAIError(404, "model_not_found", error.message);
    }

    throw error;
  }
}

function openAIError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message, type: "invalid_request_error" } },
    { status },
  );
}
