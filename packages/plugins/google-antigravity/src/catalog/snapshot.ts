import type { ModelCatalog, ModelDescriptor } from "@aio-proxy/plugin-sdk";

import { modelCapabilities } from "./families";

type SnapshotModel = Readonly<{
  id: string;
  displayName: string;
  contextWindow: number;
  supportsWebSearch: boolean;
}>;

const snapshotModels: readonly SnapshotModel[] = [
  {
    id: "claude-opus-4-6-thinking",
    displayName: "Claude Opus 4.6 (Thinking)",
    contextWindow: 200_000,
    supportsWebSearch: false,
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    contextWindow: 200_000,
    supportsWebSearch: false,
  },
  {
    id: "gemini-3-flash-agent",
    displayName: "Gemini 3.5 Flash (High)",
    contextWindow: 1_048_576,
    supportsWebSearch: true,
  },
  {
    id: "gemini-3.1-pro-low",
    displayName: "Gemini 3.1 Pro (Low)",
    contextWindow: 1_048_576,
    supportsWebSearch: true,
  },
  {
    id: "gemini-3.5-flash-extra-low",
    displayName: "Gemini 3.5 Flash (Extra Low)",
    contextWindow: 1_048_576,
    supportsWebSearch: true,
  },
  {
    id: "gemini-3.5-flash-low",
    displayName: "Gemini 3.5 Flash (Low)",
    contextWindow: 1_048_576,
    supportsWebSearch: true,
  },
  {
    id: "gemini-pro-agent",
    displayName: "Gemini 3.1 Pro (High)",
    contextWindow: 1_048_576,
    supportsWebSearch: true,
  },
] as const;

export function staticAntigravityCatalog(): ModelCatalog {
  return {
    language: snapshotModels.map(snapshotDescriptor),
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}

function snapshotDescriptor(model: SnapshotModel): ModelDescriptor {
  const profile = modelCapabilities(model.id);
  if (profile === undefined) throw new Error(`Missing verified Antigravity profile for ${model.id}`);
  return {
    id: model.id,
    displayName: model.displayName,
    metadata: {
      antigravity: {
        supportsImages: true,
        supportsThinking: true,
        supportsWebSearch: model.supportsWebSearch,
        contextWindow: model.contextWindow,
        ...profile,
      },
    },
  };
}
