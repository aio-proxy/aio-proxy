export enum ProviderFormMode {
  Create = 'create',
  Edit = 'edit',
}

// Provider-kind display labels for the three fixed-acronym kinds. These are
// proper-noun acronyms ("API", "AI SDK", "OAuth") that are identical across
// locales, so they live as literals rather than translatable messages. The
// `invalid` kind stays translatable and is resolved via i18n at its call sites.
export const PROVIDER_KIND_LABEL = {
  api: 'API',
  'ai-sdk': 'AI SDK',
  oauth: 'OAuth',
} as const;

// Example model list shown as the placeholder of the models section's manual-add box. It is a
// comma-separated pair on purpose: the box splits on `,` and newlines, so the placeholder is also
// the format hint. A locale-independent example, so it stays a literal.
export const PROVIDER_MODELS_PLACEHOLDER = 'gpt-5-mini, gpt-5';

// The package an ai-sdk provider gets when its packageName is left untouched: both the field's
// displayed value and `AiSdkPackageNameSchema.default`. An npm package name, so it stays a literal.
export const PROVIDER_AI_SDK_DEFAULT_PACKAGE = '@ai-sdk/openai-compatible';
