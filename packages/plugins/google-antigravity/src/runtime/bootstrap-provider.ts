import type { ProviderV4 } from "@ai-sdk/provider";

function unavailable(): never {
  throw new Error("Google Antigravity provider is unavailable during bootstrap");
}

export const bootstrapGoogleAntigravityProvider: ProviderV4 = {
  specificationVersion: "v4",
  languageModel: unavailable,
  embeddingModel: unavailable,
  imageModel: unavailable,
  transcriptionModel: unavailable,
  speechModel: unavailable,
  rerankingModel: unavailable,
  files: unavailable,
  skills: unavailable,
};
