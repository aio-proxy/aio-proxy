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
export type { CopilotTransport } from "./github-copilot/schema";
export {
  BaseOAuthProvider,
  type OAuthLoginCallbacks,
  type OAuthLoginForm,
  type OAuthLoginInput,
  type OAuthPrompt,
  type OAuthProviderLoginResult,
  type OAuthProviderModel,
} from "./oauth-provider";
export {
  OPENAI_CHATGPT_MODELS,
  OpenAIChatGPTOAuthProvider,
  openAIChatGPTOAuthProvider,
} from "./openai-chatgpt";
export type { ChatGPTModel, ChatGPTPayload } from "./openai-chatgpt/schema";
export { Auth } from "./store";
export type {
  AuthCasCurrent,
  AuthCasNext,
  AuthRecord,
  AuthSummary,
} from "./store-types";
