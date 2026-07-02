import {
  type JSONValue,
  jsonSchema,
  type OpenAIResponsesTransformTool,
  OpenAIResponsesUnsupportedFeatureError,
  openAIResponsesToModelMessages,
  parseOpenAIResponses,
  RouterModelNotFoundError,
  type ToolSet,
  toIngressError,
  writeOpenAIResponsesResponse,
  writeOpenAIResponsesSSE,
} from "@aio-proxy/core";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { Hono } from "hono";
import { ZodError, z } from "zod";
import { ensureAiSdkProviderAvailable } from "../provider-availability";
import type { ProviderRouteSource } from "../runtime";

const maxBodyBytes = 8 * 1_024 * 1_024;
const jsonValueSchema = z.json();

export function createOpenAIResponsesRoutes(source: ProviderRouteSource) {
  return new Hono()
    .post("/v1/responses", async (context) => {
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

      const route = resolveRoute(source, request.model);
      if (route instanceof Response) {
        return route;
      }

      const provider = route.provider;
      if (
        provider.kind === ProviderKind.Api &&
        provider.protocol === ProviderProtocol.OpenAIResponse
      ) {
        return provider.passthrough(context.req.raw);
      }

      if (provider.kind !== ProviderKind.AiSdk) {
        return unsupportedFeature("openai_responses_transform_dispatch");
      }

      const transformed = openAIResponsesToModelMessages(request);
      const tools = aiSdkTools(transformed.tools);
      if (tools instanceof Response) {
        return tools;
      }

      if (request.stream === false) {
        try {
          await ensureAiSdkProviderAvailable(provider);
          const stream = provider.invoke({
            messages: transformed.messages,
            modelId: route.modelId,
            settings: transformed.settings,
            signal: context.req.raw.signal,
            ...(tools === undefined ? {} : { tools }),
          });
          return Response.json(await writeOpenAIResponsesResponse(stream));
        } catch (error) {
          // no-excuse-ok: catch - HTTP boundary converts provider failures.
          const ingressError = toIngressError(error, "openai-chat");
          return Response.json(ingressError.body, {
            status: ingressError.status,
          });
        }
      }

      let stream: ReturnType<typeof provider.invoke>;
      try {
        await ensureAiSdkProviderAvailable(provider);
        stream = provider.invoke({
          messages: transformed.messages,
          modelId: route.modelId,
          settings: transformed.settings,
          signal: context.req.raw.signal,
          ...(tools === undefined ? {} : { tools }),
        });
      } catch (error) {
        // no-excuse-ok: catch - HTTP boundary converts provider failures.
        const ingressError = toIngressError(error, "openai-chat");
        return Response.json(ingressError.body, {
          status: ingressError.status,
        });
      }

      return new Response(writeOpenAIResponsesSSE(stream), {
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream; charset=utf-8",
        },
      });
    })
    .get("/v1/responses/:id", () => unsupportedFeature("response_retrieval"));
}

async function parseRequest(
  raw: Request,
): Promise<ReturnType<typeof parseOpenAIResponses> | Response> {
  try {
    return parseOpenAIResponses(await raw.clone().json());
  } catch (error) {
    if (error instanceof OpenAIResponsesUnsupportedFeatureError) {
      return unsupportedFeature(error.feature);
    }

    if (error instanceof SyntaxError || error instanceof ZodError) {
      return openAIError(
        400,
        "invalid_request",
        "Invalid OpenAI Responses request",
      );
    }

    throw error;
  }
}

function resolveRoute(source: ProviderRouteSource, model: string) {
  try {
    return source.currentProviderSnapshot().router.resolve(model);
  } catch (error) {
    if (error instanceof RouterModelNotFoundError) {
      return openAIError(404, "model_not_found", error.message);
    }

    throw error;
  }
}

function aiSdkTools(
  tools: readonly OpenAIResponsesTransformTool[] | undefined,
): ToolSet | Response | undefined {
  if (tools === undefined) {
    return undefined;
  }

  const result: ToolSet = {};
  for (const tool of tools) {
    if (tool.type === "custom") {
      return unsupportedFeature("custom_tool");
    }

    result[tool.name] = {
      type: "function",
      ...(tool.description === undefined
        ? {}
        : { description: tool.description }),
      inputSchema: jsonSchema(jsonSchemaObject(tool.inputSchema)),
      outputSchema: jsonSchema({}),
    };
  }

  return result;
}

function jsonSchemaObject(value: unknown): Parameters<typeof jsonSchema>[0] {
  const json = jsonValue(value);
  if (json === undefined || json === null || Array.isArray(json)) {
    return {};
  }

  if (typeof json === "object") {
    return json;
  }

  return {};
}

function jsonValue(value: unknown): JSONValue | undefined {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function unsupportedFeature(feature: string): Response {
  return Response.json(
    {
      error: {
        code: "unsupported_feature",
        message: `OpenAI Responses feature is not supported: ${feature}`,
        type: "unsupported_feature",
      },
    },
    { status: 501 },
  );
}

function openAIError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message, type: "invalid_request_error" } },
    { status },
  );
}
