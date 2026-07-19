import type { ModelMessage } from "../ai-sdk-bridge";
import { OpenAIResponsesTransformError } from "../error";
import type {
  OpenAIResponsesExecutableTool,
  OpenAIResponsesInputItem,
  OpenAIResponsesInputMessage,
  OpenAIResponsesRequest,
  OpenAIResponsesTextPart,
} from "../ingress/openai-responses";
import { readOpenAIResponsesWireMetadata } from "./openai-responses-tools";
import type {
  OpenAIResponsesFromModelMessages,
  OpenAIResponsesToolChoice,
  OpenAIResponsesTransformTool,
  OpenAIResponsesWireMetadata,
} from "./openai-responses-types";

type UserMessage = Extract<ModelMessage, { role: "user" }>;
type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type ResponsesContentInput = UserMessage["content"] | AssistantMessage["content"];

export function modelMessagesToOpenAIResponses({
  model,
  messages,
  tools,
  settings,
}: OpenAIResponsesFromModelMessages): OpenAIResponsesRequest {
  if (model === "") {
    throw new OpenAIResponsesTransformError("model");
  }

  const reasoningEffort = settings.reasoning ?? settings.providerOptions?.openai.reasoningEffort;
  const reasoningSummary = settings.reasoningSummary ?? settings.providerOptions?.openai.reasoningSummary;
  const toolSources = responsesToolSources(tools);
  const toolChoice = responsesToolChoice(settings.toolChoice, tools);

  return {
    model,
    input: responsesInput(messages, toolSources.additional),
    ...(toolSources.request === undefined ? {} : { tools: toolSources.request }),
    ...(settings.stream === undefined ? {} : { stream: settings.stream }),
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
    ...(settings.topP === undefined ? {} : { top_p: settings.topP }),
    ...(settings.maxOutputTokens === undefined ? {} : { max_output_tokens: settings.maxOutputTokens }),
    ...(settings.parallelToolCalls === undefined ? {} : { parallel_tool_calls: settings.parallelToolCalls }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(reasoningEffort === undefined && reasoningSummary === undefined
      ? {}
      : {
          reasoning: {
            ...(reasoningEffort === undefined ? {} : { effort: reasoningEffort }),
            ...(reasoningSummary === undefined ? {} : { summary: reasoningSummary }),
          },
        }),
  };
}

function responsesInput(
  messages: readonly ModelMessage[],
  additionalTools: readonly { readonly tools: OpenAIResponsesExecutableTool[] }[],
): OpenAIResponsesInputItem[] {
  return [
    ...additionalTools.map<OpenAIResponsesInputItem>((additional) => ({
      type: "additional_tools",
      role: "developer",
      tools: additional.tools,
    })),
    ...messages.map((message, messageIndex) => responsesMessage(message, messageIndex)),
  ];
}

function responsesMessage(message: ModelMessage, messageIndex: number): OpenAIResponsesInputMessage {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return {
        role: "user",
        content: responsesContent(message.content, "input_text"),
      };
    case "assistant":
      return {
        role: "assistant",
        content: responsesContent(message.content, "output_text"),
      };
    case "tool":
      throw new OpenAIResponsesTransformError(`messages.${messageIndex}.role`);
  }
}

function responsesContent(
  content: ResponsesContentInput,
  type: OpenAIResponsesTextPart["type"],
): string | OpenAIResponsesTextPart[] {
  if (typeof content === "string") {
    return content;
  }

  return content.flatMap((part) => (part.type === "text" ? [{ type, text: part.text }] : []));
}

function responsesToolSources(tools: readonly OpenAIResponsesTransformTool[] | undefined): {
  readonly request: OpenAIResponsesExecutableTool[] | undefined;
  readonly additional: readonly { readonly inputIndex: number; readonly tools: OpenAIResponsesExecutableTool[] }[];
} {
  const request: OpenAIResponsesExecutableTool[] = [];
  const additional = new Map<number, OpenAIResponsesExecutableTool[]>();
  const namespaces = new Map<
    OpenAIResponsesExecutableTool[],
    Map<string, Extract<OpenAIResponsesExecutableTool, { type: "namespace" }>>
  >();
  for (const tool of tools ?? []) {
    const metadata = readOpenAIResponsesWireMetadata(tool.metadata);
    const target =
      metadata?.source === "additional_tools" && metadata.inputIndex !== undefined
        ? mapTools(additional, metadata.inputIndex)
        : request;
    if (metadata?.namespace !== undefined) {
      const sourceNamespaces = mapNamespaces(namespaces, target);
      const namespace = sourceNamespaces.get(metadata.namespace) ?? {
        type: "namespace" as const,
        name: metadata.namespace,
        ...(metadata.namespaceDescription === undefined ? {} : { description: metadata.namespaceDescription }),
        tools: [],
      };
      namespace.tools.push(functionTool(tool, metadata.wireToolName ?? tool.name));
      if (!sourceNamespaces.has(metadata.namespace)) {
        sourceNamespaces.set(metadata.namespace, namespace);
        target.push(namespace);
      }
      continue;
    }
    if (metadata?.wireToolType === "custom") {
      target.push({
        type: "custom",
        name: metadata.wireToolName ?? tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(metadata.format === undefined ? {} : { format: metadata.format }),
      });
      continue;
    }
    target.push(functionTool(tool, metadata?.wireToolName ?? tool.name));
  }
  return {
    request: request.length === 0 ? undefined : request,
    additional: [...additional.entries()]
      .sort(([left], [right]) => left - right)
      .map(([inputIndex, sourceTools]) => ({ inputIndex, tools: sourceTools })),
  };
}

function mapTools(map: Map<number, OpenAIResponsesExecutableTool[]>, inputIndex: number) {
  const tools = map.get(inputIndex) ?? [];
  map.set(inputIndex, tools);
  return tools;
}

function mapNamespaces(
  map: Map<OpenAIResponsesExecutableTool[], Map<string, Extract<OpenAIResponsesExecutableTool, { type: "namespace" }>>>,
  tools: OpenAIResponsesExecutableTool[],
) {
  const namespaces = map.get(tools) ?? new Map();
  map.set(tools, namespaces);
  return namespaces;
}

function responsesToolChoice(
  choice: OpenAIResponsesToolChoice | undefined,
  tools: readonly OpenAIResponsesTransformTool[] | undefined,
): OpenAIResponsesRequest["tool_choice"] {
  if (choice === undefined || typeof choice === "string") return choice;
  const tool = tools?.find((candidate) => candidate.name === choice.toolName);
  const metadata: OpenAIResponsesWireMetadata | undefined = readOpenAIResponsesWireMetadata(tool?.metadata);
  return {
    type: metadata?.wireToolType === "custom" ? "custom" : "function",
    name: metadata?.wireToolName ?? choice.toolName,
  };
}

function functionTool(
  tool: OpenAIResponsesTransformTool,
  name: string,
): Extract<OpenAIResponsesExecutableTool, { type: "function" }> {
  return {
    type: "function",
    name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.inputSchema === undefined ? {} : { parameters: tool.inputSchema }),
    ...(tool.strict === undefined ? {} : { strict: tool.strict }),
  };
}
