// Fallback when the latest Codex release cannot be read, and the catalog
// client version when the user agent template does not ask for that release.
// The models endpoint gates each model on `minimal_client_version`.
export const CODEX_CLIENT_VERSION = '0.153.4';

// Single braces on purpose. Config loading already treats `{{...}}` as an
// environment-variable template and rejects every other mustache.
export const LATEST_CODEX_RS_VERSION_TOKEN = '{latest_codex_rs_version}';

export const DEFAULT_CHATGPT_USER_AGENT = `codex-tui/${LATEST_CODEX_RS_VERSION_TOKEN} (Mac OS 27.0.0; arm64) otty/1.5.1 (codex-tui; ${LATEST_CODEX_RS_VERSION_TOKEN})`;

export const CHATGPT_USER_AGENT = DEFAULT_CHATGPT_USER_AGENT.replaceAll(
  LATEST_CODEX_RS_VERSION_TOKEN,
  CODEX_CLIENT_VERSION,
);
