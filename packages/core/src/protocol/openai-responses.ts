import { ProviderProtocol } from "@aio-proxy/types";
import { writeOpenAIResponsesResponse, writeOpenAIResponsesSSE } from "../egress/openai-responses";
import { OpenAIResponsesUnsupportedFeatureError } from "../error";
import { type OpenAIResponsesRequest, parseOpenAIResponses } from "../ingress/openai-responses";
import { openAIResponsesToModelMessages } from "../transform/openai-responses";
import { defineProtocolAdapter, type EmptyProtocolContext } from "./adapter";
import { openAIResponsesErrors } from "./errors";
import { readJsonRequest, rewriteJsonRequestModel } from "./request";
import { functionToolSet } from "./tools";

export const openAIResponsesAdapter = defineProtocolAdapter<OpenAIResponsesRequest, EmptyProtocolContext>({
  protocol: ProviderProtocol.OpenAIResponse,
  async parse(raw) {
    return parseOpenAIResponses(await readJsonRequest(raw));
  },
  model: (request) => request.model,
  variant: (request) => request.reasoning?.effort,
  wantsStream: (request) => request.stream === true,
  rawRequest(raw, request, resolvedModel) {
    return request.model === resolvedModel ? Promise.resolve(raw.clone()) : rewriteJsonRequestModel(raw, resolvedModel);
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
