export type AuthFlowStatus = "idle" | "pending" | "authenticated";
export {
  AuthCasBusyError,
  AuthPayloadParseError,
  AuthPayloadSerializationError,
  StaleProviderGenerationError,
} from "./errors";
export {
  GitHubCopilotOAuthProvider,
  getGitHubCopilotBaseUrl,
  githubCopilotOAuthProvider,
  normalizeDomain,
} from "./github-copilot";
export {
  BaseOAuthProvider,
  type OAuthLoginCallbacks,
  type OAuthLoginForm,
  type OAuthLoginInput,
  type OAuthPrompt,
  type OAuthProviderLoginResult,
  type OAuthProviderModel,
} from "./oauth-provider";
export { Auth } from "./store";
export type {
  AuthCasCurrent,
  AuthCasNext,
  AuthRecord,
  AuthSummary,
} from "./store-types";
