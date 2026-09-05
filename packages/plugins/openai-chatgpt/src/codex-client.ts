// Pinned to the codex-tui build this plugin impersonates. The ChatGPT models
// endpoint gates each model on its `minimal_client_version`, so this value
// decides which models the catalog can see: 0.123.0 hides gpt-5.5, 0.135.0 hides
// the gpt-5.6 family (`minimal_client_version` 0.144.0) and gpt-6-astra
// (0.153.0), and an inflated version surfaces unreleased models the account is
// not meant to have. Keep it at a real published codex release and bump it when
// upstream ships one, or the catalog silently freezes on an old model set.
export const CODEX_CLIENT_VERSION = '0.153.4';

export const CHATGPT_USER_AGENT =
  `codex-tui/${CODEX_CLIENT_VERSION} (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; ${CODEX_CLIENT_VERSION})` as const;
