import { ProviderProtocol } from "@aio-proxy/types";
import { writeOpenAICompletionsResponse, writeOpenAICompletionsSSE } from "../egress/openai-completions";
import { type OpenAICompletionsRequest, parseOpenAICompletions } from "../ingress/openai-completions";
import { openAICompletionsToModelMessages } from "../transform/openai-completions";
import { defineProtocolAdapter, type EmptyProtocolContext } from "./adapter";
import { openAICompletionsErrors } from "./errors";
import { readJsonRequest, rewriteJsonRequestModel } from "./request";
import { functionToolSet } from "./tools";

export const openAICompletionsAdapter = defineProtocolAdapter<OpenAICompletionsRequest, EmptyProtocolContext>({
  protocol: ProviderProtocol.OpenAICompatible,
  async parse(raw) {
    return parseOpenAICompletions(await readJsonRequest(raw));
  },
  model: (request) => request.model,
  variant: (request) => request.reasoning_effort,
  wantsStream: (request) => request.stream === true,
  rawRequest(raw, request, resolvedModel) {
    return request.model === resolvedModel ? Promise.resolve(raw.clone()) : rewriteJsonRequestModel(raw, resolvedModel);
  },
  modelInvocation(request) {
    const transformed = openAICompletionsToModelMessages(request);
    const tools = functionToolSet(transformed.tools);
    return {
      messages: transformed.messages,
      settings: transformed.settings,
      ...(tools === undefined ? {} : { tools }),
    };
  },
  modelJson: writeOpenAICompletionsResponse,
  modelSse: writeOpenAICompletionsSSE,
  errors: openAICompletionsErrors,
});
