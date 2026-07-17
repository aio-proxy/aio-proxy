import packageJson from "../package.json" with { type: "json" };
import { createGitHubCopilotPlugin, englishPresentationText } from "./plugin";

export type { GitHubAccountOptions, GitHubCopilotCredential } from "./github-api";
export { COPILOT_CATALOG_TTL_MS } from "./github-api/catalog";
export {
  createGitHubCopilotPlugin,
  englishPresentationText,
  type GitHubCopilotPresentationText,
} from "./plugin";

export const GITHUB_COPILOT_PLUGIN_VERSION = packageJson.version;

export default createGitHubCopilotPlugin(englishPresentationText);
