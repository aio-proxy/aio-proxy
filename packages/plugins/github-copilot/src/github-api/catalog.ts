import type { CredentialPort, ModelDescriptor, ProtocolId } from "@aio-proxy/plugin-sdk";
import { copilotModelSchema, modelsResponseSchema } from "../schema";
import { currentGitHubCopilotCredential } from "./credential";
import { copilotHeaders, fetchJson } from "./http";
import type { GitHubCopilotCredential } from "./types";

export async function discoverGitHubCopilotModels(
  credentials: CredentialPort<GitHubCopilotCredential>,
  signal: AbortSignal,
): Promise<readonly ModelDescriptor[]> {
  const current = await currentGitHubCopilotCredential(credentials);
  const { data } = await fetchJson(
    `${current.baseURL}/models`,
    { headers: copilotHeaders(current.copilotToken), signal },
    modelsResponseSchema,
  );
  return data.flatMap((item) => {
    const model = modelEntry(item);
    return model === undefined ? [] : [model];
  });
}

function modelEntry(value: unknown): ModelDescriptor | undefined {
  const result = copilotModelSchema.safeParse(value);
  if (!result.success) return undefined;
  const record = result.data;
  if (record.model_picker_enabled === false || record.capabilities === false) return undefined;
  const protocol = protocolFromEndpoints(record.endpoints);
  if (protocol === undefined) return undefined;
  return {
    id: record.id,
    ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
    metadata: { protocol },
  };
}

function protocolFromEndpoints(endpoints: readonly string[]): ProtocolId | undefined {
  if (endpoints.some((endpoint) => endpoint.includes("/v1/messages"))) return "anthropic";
  if (endpoints.some((endpoint) => endpoint.includes("/responses"))) return "openai-response";
  if (endpoints.some((endpoint) => endpoint.includes("/chat/completions"))) return "openai-compatible";
  return undefined;
}
