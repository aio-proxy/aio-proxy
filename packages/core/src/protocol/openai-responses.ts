import { ProviderProtocol } from "@aio-proxy/types";
import { z } from "zod";
import { writeOpenAIResponsesResponse, writeOpenAIResponsesSSE } from "../egress/openai-responses";
import { OpenAIResponsesUnsupportedFeatureError } from "../error";
import { type OpenAIResponsesRequest, parseOpenAIResponses } from "../ingress/openai-responses/index";
import { openAIResponsesToModelMessages } from "../transform/openai-responses";
import { defineProtocolAdapter, type EmptyProtocolContext } from "./adapter";
import { openAIResponsesErrors } from "./errors";
import { readJsonRequest } from "./request";
import type { SessionCandidate } from "./session";
import { functionToolSet } from "./tools";

export const openAIResponsesAdapter = defineProtocolAdapter<OpenAIResponsesRequest, EmptyProtocolContext>({
  protocol: ProviderProtocol.OpenAIResponse,
  async parse(raw) {
    return parseOpenAIResponses(await readJsonRequest(raw));
  },
  model: (request) => request.model,
  variant: (request) => request.reasoning?.effort,
  requestDiagnostics: (request) =>
    request.background === true ? [{ feature: "background", action: "dropped", effectiveMode: "synchronous" }] : [],
  session: (request) => ({
    candidates: [
      candidate("openai-conversation", conversationId(request.conversation)),
      candidate("openai-prompt-cache", request.prompt_cache_key),
      candidate("body-session", request.metadata?.session_id),
      candidate("body-conversation", request.metadata?.conversation_id),
      candidate("body-session", request.session_id),
      candidate("body-conversation", request.conversation_id),
    ].filter(isCandidate),
    ...(request.previous_response_id === undefined ? {} : { previousResponseId: request.previous_response_id }),
    transcript: request.input,
  }),
  wantsStream: (request) => request.stream === true,
  rawRequest(raw, request, resolvedModel) {
    return request.model === resolvedModel && request.background === undefined
      ? Promise.resolve(raw.clone())
      : rewriteOpenAIResponsesRequest(raw, resolvedModel);
  },
  modelInvocation(request) {
    const transformed = openAIResponsesToModelMessages(request);
    const custom = transformed.tools?.find((tool) => tool.type === "custom");
    if (custom !== undefined) {
      throw new OpenAIResponsesUnsupportedFeatureError("custom_tool", "tools");
    }
    const tools = functionToolSet(transformed.tools);
    return {
      messages: transformed.messages,
      settings: transformed.settings,
      ...(tools === undefined ? {} : { tools }),
    };
  },
  modelJson: writeOpenAIResponsesResponse,
  modelSse: writeOpenAIResponsesSSE,
  errors: openAIResponsesErrors,
});

const jsonObjectSchema = z.object({}).catchall(z.unknown());

async function rewriteOpenAIResponsesRequest(raw: Request, resolvedModel: string): Promise<Request> {
  const { background: _background, ...body } = jsonObjectSchema.parse(await readJsonRequest(raw));
  const headers = new Headers(raw.headers);
  headers.delete("content-length");
  return new Request(raw, {
    body: JSON.stringify({ ...body, model: resolvedModel }),
    headers,
  });
}

function conversationId(conversation: OpenAIResponsesRequest["conversation"]): string | undefined {
  return typeof conversation === "string" ? conversation : conversation?.id;
}

function candidate(source: SessionCandidate["source"], value: string | undefined): SessionCandidate | undefined {
  return value === undefined ? undefined : { source, value };
}

function isCandidate(value: SessionCandidate | undefined): value is SessionCandidate {
  return value !== undefined;
}
