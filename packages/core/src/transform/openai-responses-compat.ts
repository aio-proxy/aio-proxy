import type { ModelMessage } from "../ai-sdk-bridge";
import type {
  OpenAIResponsesInputItem,
  OpenAIResponsesInputMessage,
  OpenAIResponsesToolOutputPart,
} from "../ingress/openai-responses";
import type { OpenAIResponsesWireMetadata } from "./openai-responses-types";

import { OpenAIResponsesTransformError } from "../error";
import {
  flattenOpenAIResponsesToolName,
  rejectOpenAIResponsesFeature,
  warnOpenAIResponsesDegradation,
  wireProviderOptions,
} from "./openai-responses-tools";

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;
type AssistantPart = Exclude<AssistantMessage["content"], string>[number];
type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type ToolResultPart = Extract<ToolMessage["content"][number], { type: "tool-result" }>;
type CallIdentity = {
  readonly flattenedName: string;
  readonly metadata?: OpenAIResponsesWireMetadata;
};

export function openAIResponsesInputMessages(items: readonly OpenAIResponsesInputItem[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const calls = new Map<string, CallIdentity>();
  let previous: "call" | "result" | undefined;

  for (const [index, item] of items.entries()) {
    if ("role" in item && item.type !== "additional_tools") {
      messages.push(inputMessage(item, index));
      previous = undefined;
      continue;
    }

    switch (item.type) {
      case "additional_tools":
        previous = undefined;
        break;
      case "agent_message": {
        warnOpenAIResponsesDegradation("agent_message.role", `input.${index}.type`, "converted");
        const text: string[] = [];
        for (const [partIndex, part] of item.content.entries()) {
          if (part.type === "input_text") {
            text.push(part.text);
          } else {
            warnOpenAIResponsesDegradation(
              "agent_message.encrypted_content",
              `input.${index}.content.${partIndex}.type`,
              "dropped",
            );
          }
        }
        if (text.length > 0) {
          messages.push({
            role: "user",
            content: `[agent ${item.author} -> ${item.recipient}] ${text.join("")}`,
            providerOptions: wireProviderOptions({
              protocol: "openai-responses",
              inputIndex: index,
              itemType: item.type,
              ...(item.id === undefined ? {} : { itemId: item.id }),
              author: item.author,
              recipient: item.recipient,
            }),
          });
        }
        previous = undefined;
        break;
      }
      case "reasoning": {
        if (item.encrypted_content != null) {
          warnOpenAIResponsesDegradation("reasoning.encrypted_content", `input.${index}.encrypted_content`, "dropped");
        }
        const text = item.summary.map((part) => part.text).join("");
        if (text !== "") {
          warnOpenAIResponsesDegradation("reasoning.summary", `input.${index}.summary`, "converted");
          const part: AssistantPart = {
            type: "reasoning",
            text,
            providerOptions: wireProviderOptions({
              protocol: "openai-responses",
              inputIndex: index,
              itemType: item.type,
              ...(item.id === undefined ? {} : { itemId: item.id }),
              ...(item.status === undefined ? {} : { status: item.status }),
            }),
          };
          messages.push({ role: "assistant", content: [part] });
        }
        previous = undefined;
        break;
      }
      case "item_reference":
        return rejectOpenAIResponsesFeature(item.type, `input.${index}.type`);
      case "__aio_proxy_unsupported__":
        return rejectOpenAIResponsesFeature(item.wireType, `input.${index}.type`);
      case "function_call": {
        const flattenedName = flattenOpenAIResponsesToolName(item.namespace, item.name);
        const metadata =
          item.namespace === undefined && item.id === undefined && item.status === undefined
            ? undefined
            : ({
                protocol: "openai-responses",
                inputIndex: index,
                itemType: item.type,
                ...(item.id === undefined ? {} : { itemId: item.id }),
                ...(item.status === undefined ? {} : { status: item.status }),
                wireToolType: "function",
                wireToolName: item.name,
                ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
              } satisfies OpenAIResponsesWireMetadata);
        calls.set(item.call_id, { flattenedName, ...(metadata === undefined ? {} : { metadata }) });
        appendAssistantPart(messages, previous, {
          type: "tool-call",
          toolCallId: item.call_id,
          toolName: flattenedName,
          input: parseArguments(item.arguments, `input.${index}.arguments`),
          ...(metadata === undefined ? {} : { providerOptions: wireProviderOptions(metadata) }),
        });
        previous = "call";
        break;
      }
      case "custom_tool_call": {
        const metadata = {
          protocol: "openai-responses",
          inputIndex: index,
          itemType: item.type,
          ...(item.id === undefined ? {} : { itemId: item.id }),
          ...(item.status === undefined ? {} : { status: item.status }),
          wireToolType: "custom",
          wireToolName: item.name,
        } satisfies OpenAIResponsesWireMetadata;
        calls.set(item.call_id, { flattenedName: item.name, metadata });
        appendAssistantPart(messages, previous, {
          type: "tool-call",
          toolCallId: item.call_id,
          toolName: item.name,
          input: { input: item.input },
          providerOptions: wireProviderOptions(metadata),
        });
        previous = "call";
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const call = calls.get(item.call_id);
        if (call === undefined) throw new OpenAIResponsesTransformError(`input.${index}.call_id`);
        const custom = item.type === "custom_tool_call_output";
        const metadata = {
          protocol: "openai-responses",
          inputIndex: index,
          itemType: item.type,
          ...(item.id === undefined ? {} : { itemId: item.id }),
          ...(item.status === undefined ? {} : { status: item.status }),
          ...(call.metadata?.wireToolType === undefined ? {} : { wireToolType: call.metadata.wireToolType }),
          ...(call.metadata?.wireToolName === undefined ? {} : { wireToolName: call.metadata.wireToolName }),
          ...(call.metadata?.namespace === undefined ? {} : { namespace: call.metadata.namespace }),
          outputKind: typeof item.output === "string" ? "string" : "content",
        } satisfies OpenAIResponsesWireMetadata;
        const part: ToolResultPart = {
          type: "tool-result",
          toolCallId: item.call_id,
          toolName: call.flattenedName,
          output: toolOutput(item.output, `input.${index}.output`),
          ...(custom || call.metadata !== undefined ? { providerOptions: wireProviderOptions(metadata) } : {}),
        };
        appendToolResult(messages, previous, part);
        previous = "result";
        break;
      }
    }
  }

  return messages;
}

function inputMessage(message: OpenAIResponsesInputMessage, index: number): ModelMessage {
  const metadata: OpenAIResponsesWireMetadata | undefined =
    message.type === undefined &&
    message.id === undefined &&
    message.status === undefined &&
    message.phase === undefined &&
    message.role !== "developer"
      ? undefined
      : {
          protocol: "openai-responses",
          inputIndex: index,
          itemType: message.type ?? "message",
          ...(message.id === undefined ? {} : { itemId: message.id }),
          ...(message.status === undefined ? {} : { status: message.status }),
          ...(message.phase === undefined ? {} : { phase: message.phase }),
          wireRole: message.role,
        };
  if (message.role === "developer") {
    warnOpenAIResponsesDegradation("message.role.developer", `input.${index}.role`, "converted");
  }
  const content = messageTextContent(message, index);
  const options = metadata === undefined ? {} : { providerOptions: wireProviderOptions(metadata) };
  switch (message.role) {
    case "system":
    case "developer":
      return {
        role: "system",
        content: typeof content === "string" ? content : content.map((part) => part.text).join(""),
        ...options,
      };
    case "user":
      return { role: "user", content, ...options };
    case "assistant":
      return { role: "assistant", content, ...options };
  }
}

function messageTextContent(
  message: OpenAIResponsesInputMessage,
  index: number,
): string | { type: "text"; text: string }[] {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part, partIndex) => {
    if (!("text" in part) || typeof part.text !== "string") {
      return rejectOpenAIResponsesFeature(part.type, `input.${index}.content.${partIndex}.type`);
    }
    if (part.annotations !== undefined || part.logprobs !== undefined) {
      warnOpenAIResponsesDegradation("message.content_metadata", `input.${index}.content.${partIndex}`, "dropped");
    }
    return { type: "text", text: part.text };
  });
}

function toolOutput(output: string | OpenAIResponsesToolOutputPart[], path: string): ToolResultPart["output"] {
  if (typeof output === "string") return { type: "text", value: output };
  return {
    type: "content",
    value: output.map((part, index) => {
      if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
        return { type: "text", text: part.text };
      }
      return rejectOpenAIResponsesFeature(part.type, `${path}.${index}.type`);
    }),
  };
}

function appendAssistantPart(messages: ModelMessage[], previous: "call" | "result" | undefined, part: AssistantPart) {
  const last = messages.at(-1);
  if (previous === "call" && last?.role === "assistant" && typeof last.content !== "string") {
    messages[messages.length - 1] = { ...last, content: [...last.content, part] };
    return;
  }
  messages.push({ role: "assistant", content: [part] });
}

function appendToolResult(messages: ModelMessage[], previous: "call" | "result" | undefined, part: ToolResultPart) {
  const last = messages.at(-1);
  if (previous === "result" && last?.role === "tool") {
    messages[messages.length - 1] = { ...last, content: [...last.content, part] };
    return;
  }
  messages.push({ role: "tool", content: [part] });
}

function parseArguments(value: string, path: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) throw new OpenAIResponsesTransformError(path);
    throw error;
  }
}
