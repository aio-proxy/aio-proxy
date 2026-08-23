import type { ModelCatalog, ModelDescriptor } from '@aio-proxy/plugin-sdk';

import { type AntigravityPickerFields, assembleAntigravityCatalog } from './discover';

type SnapshotModel = Readonly<{
  id: string;
  displayName?: string;
  contextWindow: number;
  supportsWebSearch: boolean;
  apiProvider: string;
  modelEnum?: string;
  maxOutputTokens?: number;
  thinkingBudget?: number;
}>;

const GEMINI_CONTEXT = 1_048_576;
const DEFAULT_CONTEXT = 200_000;

const snapshotModels: readonly SnapshotModel[] = [
  {
    id: 'gemini-3.7-flash-tiered',
    contextWindow: GEMINI_CONTEXT,
    supportsWebSearch: true,
    apiProvider: 'gemini',
    thinkingBudget: -1,
  },
  {
    id: 'gemini-3.6-flash-low',
    displayName: 'Gemini 3.6 Flash (Low)',
    contextWindow: GEMINI_CONTEXT,
    supportsWebSearch: true,
    apiProvider: 'gemini',
    thinkingBudget: -1,
  },
  {
    id: 'gemini-3.6-flash-medium',
    displayName: 'Gemini 3.6 Flash (Medium)',
    contextWindow: GEMINI_CONTEXT,
    supportsWebSearch: true,
    apiProvider: 'gemini',
    thinkingBudget: -1,
  },
  {
    id: 'gemini-3.6-flash-high',
    displayName: 'Gemini 3.6 Flash (High)',
    contextWindow: GEMINI_CONTEXT,
    supportsWebSearch: true,
    apiProvider: 'gemini',
    thinkingBudget: -1,
  },
  {
    id: 'gemini-3.6-flash-tiered',
    contextWindow: GEMINI_CONTEXT,
    supportsWebSearch: true,
    apiProvider: 'gemini',
    thinkingBudget: -1,
  },
  {
    id: 'gemini-3.5-flash-extra-low',
    displayName: 'Gemini 3.5 Flash (Low)',
    contextWindow: GEMINI_CONTEXT,
    supportsWebSearch: true,
    apiProvider: 'gemini',
    modelEnum: 'MODEL_PLACEHOLDER_M187',
    maxOutputTokens: 65_536,
    thinkingBudget: 1000,
  },
  {
    id: 'gemini-3.5-flash-low',
    displayName: 'Gemini 3.5 Flash (Medium)',
    contextWindow: GEMINI_CONTEXT,
    supportsWebSearch: true,
    apiProvider: 'gemini',
    modelEnum: 'MODEL_PLACEHOLDER_M20',
    maxOutputTokens: 65_536,
    thinkingBudget: 4000,
  },
  {
    id: 'gemini-3-flash-agent',
    displayName: 'Gemini 3.5 Flash (High)',
    contextWindow: GEMINI_CONTEXT,
    supportsWebSearch: true,
    apiProvider: 'gemini',
    modelEnum: 'MODEL_PLACEHOLDER_M132',
    maxOutputTokens: 65_536,
    thinkingBudget: 10_000,
  },
  {
    id: 'gemini-3.1-pro-low',
    displayName: 'Gemini 3.1 Pro (Low)',
    contextWindow: GEMINI_CONTEXT,
    supportsWebSearch: true,
    apiProvider: 'gemini',
    modelEnum: 'MODEL_PLACEHOLDER_M36',
    maxOutputTokens: 65_535,
    thinkingBudget: 1001,
  },
  {
    id: 'gemini-pro-agent',
    displayName: 'Gemini 3.1 Pro (High)',
    contextWindow: GEMINI_CONTEXT,
    supportsWebSearch: true,
    apiProvider: 'gemini',
    modelEnum: 'MODEL_PLACEHOLDER_M16',
    maxOutputTokens: 65_535,
    thinkingBudget: 10_001,
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    contextWindow: DEFAULT_CONTEXT,
    supportsWebSearch: false,
    apiProvider: 'anthropic',
    maxOutputTokens: 64_000,
  },
  {
    id: 'claude-opus-4-6-thinking',
    displayName: 'Claude Opus 4.6 (Thinking)',
    contextWindow: DEFAULT_CONTEXT,
    supportsWebSearch: false,
    apiProvider: 'anthropic',
    maxOutputTokens: 64_000,
  },
  {
    id: 'gpt-oss-120b',
    displayName: 'GPT-OSS 120B (Medium)',
    contextWindow: DEFAULT_CONTEXT,
    supportsWebSearch: false,
    apiProvider: 'openai',
  },
];

const snapshotPicker: AntigravityPickerFields = {
  agentModelSorts: [
    {
      displayName: 'Recommended',
      groups: [
        {
          modelIds: [
            'gemini-3.6-flash-low',
            'gemini-3.6-flash-medium',
            'gemini-3.6-flash-high',
            'gemini-3.6-flash-tiered',
            'gemini-3.5-flash-extra-low',
            'gemini-3.5-flash-low',
            'gemini-3-flash-agent',
            'gemini-3.1-pro-low',
            'gemini-3.1-pro-high',
            'gemini-pro-agent',
            'claude-sonnet-4-6',
            'claude-opus-4-6-thinking',
            'gpt-oss-120b',
          ],
        },
      ],
    },
  ],
  tieredModelIds: { flash: ['gemini-3.7-flash-tiered'] },
  deprecatedModelIds: { 'gemini-3.1-pro-high': { newModelId: 'gemini-pro-agent' } },
};

export function staticAntigravityCatalog(): ModelCatalog {
  return assembleAntigravityCatalog(snapshotModels.map(snapshotDescriptor), snapshotPicker);
}

function snapshotDescriptor(model: SnapshotModel): ModelDescriptor {
  return {
    id: model.id,
    ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
    metadata: {
      antigravity: {
        supportsImages: true,
        supportsThinking: true,
        supportsWebSearch: model.supportsWebSearch,
        contextWindow: model.contextWindow,
        apiProvider: model.apiProvider,
        ...(model.modelEnum === undefined ? {} : { modelEnum: model.modelEnum }),
        ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
        ...(model.thinkingBudget === undefined ? {} : { thinkingBudget: model.thinkingBudget }),
      },
    },
  };
}
