// Pinned to the codex-tui build this plugin impersonates. The ChatGPT models
// endpoint gates each model on its `minimal_client_version`, so this value
// decides which models the catalog can see: 0.123.0 hides gpt-5.5, and an
// inflated version surfaces unreleased models the account is not meant to have.
export const CODEX_CLIENT_VERSION = '0.135.0';

export const CHATGPT_USER_AGENT =
  `codex-tui/${CODEX_CLIENT_VERSION} (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; ${CODEX_CLIENT_VERSION})` as const;
