import packageJson from "../package.json" with { type: "json" };
import { createGoogleAntigravityPlugin, englishPresentationText } from "./plugin";

export * from "./catalog/aliases";
export * from "./catalog/discover";
export * from "./catalog/errors";
export * from "./catalog/families";
export * from "./catalog/snapshot";
export {
  ANTIGRAVITY_DAILY,
  ANTIGRAVITY_PROD,
  GOOGLE_ANTIGRAVITY_SCOPES,
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_CLIENT_ID,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
} from "./oauth/constants";
export * from "./oauth/flow";
export * from "./oauth/project";
export * from "./oauth/refresh";
export * from "./oauth/userinfo";
export {
  createGoogleAntigravityPlugin,
  englishPresentationText,
  type GoogleAntigravityPluginDependencies,
  type GoogleAntigravityPresentationText,
} from "./plugin";
export * from "./protocol/thinking";
export * from "./runtime/endpoints";
export * from "./runtime/google-fetch";
export * from "./runtime/google-model";
export * from "./runtime/hub-version";
export * from "./runtime/private-options";
export * from "./runtime/provider";
export {
  accountOptionsSchema,
  credentialSchema,
  type GoogleAntigravityAccountOptions,
  type GoogleAntigravityCredential,
  normalizeBaseURL,
} from "./schema";

export const GOOGLE_ANTIGRAVITY_PLUGIN_VERSION = packageJson.version;

export default createGoogleAntigravityPlugin(englishPresentationText);
