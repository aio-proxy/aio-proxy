import type { ModelsDevCapabilities } from "@aio-proxy/core";

import { ProviderProtocol } from "@aio-proxy/types";

export const config = {
  providers: {
    "openai-compatible": {
      kind: "api",
      protocol: ProviderProtocol.OpenAICompatible,
      apiKey: "sk-abcdefghijklmnopqrstuvwxyz",
      baseURL: "https://api.example.com",
      models: ["gpt-test"],
      alias: {
        "gpt-alias": { model: "gpt-test", preserve: true },
      },
    },
    compatible: {
      kind: "ai-sdk",
      packageName: "@ai-sdk/openai-compatible",
      options: {
        apiKey: "Bearer super-secret-token",
        baseURL: "https://compatible.example.com",
        headers: {
          authorization: "Token provider-secret",
          "x-api-key": "header-secret",
        },
        name: "compatible",
      },
      models: ["compatible", "compatible-test"],
      alias: {
        compatible: { model: "compatible-test", preserve: false },
      },
    },
  },
};

export const noModelsDevCatalog = async () => undefined;

export const testCapabilities: ModelsDevCapabilities = {
  effort: {
    high: { supported: true },
    low: { supported: true },
    max: { supported: false },
    medium: { supported: true },
    supported: true,
    xhigh: { supported: false },
  },
  image_input: { supported: true },
  pdf_input: { supported: true },
  structured_outputs: { supported: true },
  thinking: {
    supported: true,
    types: { adaptive: { supported: true }, enabled: { supported: true } },
  },
};

type ExpectedModelMetadata = {
  readonly capabilities?: ModelsDevCapabilities;
  readonly created?: number;
  readonly createdAt?: string;
  readonly maxInputTokens?: number;
  readonly maxTokens?: number;
};

export const expectedModel = (
  id: string,
  ownedBy: string,
  displayName: string = id,
  metadata: ExpectedModelMetadata = {},
) => ({
  capabilities: metadata.capabilities ?? null,
  created: metadata.created ?? 0,
  created_at: metadata.createdAt ?? "1970-01-01T00:00:00Z",
  display_name: displayName,
  id,
  max_input_tokens: metadata.maxInputTokens ?? null,
  max_tokens: metadata.maxTokens ?? null,
  object: "model",
  owned_by: ownedBy,
  type: "model",
});

export const expectedModelList = (data: ReturnType<typeof expectedModel>[]) => ({
  data,
  first_id: data[0]?.id ?? null,
  has_more: false,
  last_id: data.at(-1)?.id ?? null,
  object: "list",
});
