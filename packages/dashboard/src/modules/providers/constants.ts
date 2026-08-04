export enum ProviderFormMode {
  Create = 'create',
  Edit = 'edit',
}

export type ProviderFormStep = 0 | 1 | 2 | 3;

// Provider-kind display labels for the three fixed-acronym kinds. These are
// proper-noun acronyms ("API", "AI SDK", "OAuth") that are identical across
// locales, so they live as literals rather than translatable messages. The
// `invalid` kind stays translatable and is resolved via i18n at its call sites.
export const PROVIDER_KIND_LABEL = {
  api: 'API',
  'ai-sdk': 'AI SDK',
  oauth: 'OAuth',
} as const;

// Example model list shown as the models-field placeholder in both the API and
// AI SDK provider forms. A locale-independent example, so it stays a literal.
export const PROVIDER_MODELS_PLACEHOLDER = 'gpt-5-mini, gpt-5';
