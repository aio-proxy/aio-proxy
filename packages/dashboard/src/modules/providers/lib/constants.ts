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

// Diameter in px of the frame every Provider mark is drawn in — the avatar, each protocol in the
// stack, and the stack's overflow bubble. Kept in one place because those three must agree: the
// frames are what the eye aligns on, so a mismatch reads as icons of different sizes.
export const PROVIDER_FRAME_SIZE = 20;

// The same frame at the quota dialog's larger header scale.
export const PROVIDER_DIALOG_FRAME_SIZE = 32;

// Fraction of an avatar/protocol frame the artwork occupies. Lobe icons ship wildly different
// padding — `codex-color` fills its canvas edge-to-edge while `anthropic` reaches ~70% — so drawing
// them at the frame size makes one Provider's mark look twice another's. Insetting every icon inside
// a same-size frame is what makes them read as one size: the frame aligns, and the leftover padding
// difference is scaled down with the art.
export const PROVIDER_ICON_INSET = 0.75;
