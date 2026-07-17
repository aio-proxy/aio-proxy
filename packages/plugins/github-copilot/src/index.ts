import packageJson from "../package.json" with { type: "json" };
import { createGitHubCopilotPlugin, englishPresentationText } from "./plugin";

export type { GitHubAccountOptions, GitHubCopilotCredential } from "./github-api";
export {
  createGitHubCopilotPlugin,
  englishPresentationText,
  type GitHubCopilotPresentationText,
} from "./plugin";

export const GITHUB_COPILOT_PLUGIN_VERSION = packageJson.version;
export const COPILOT_CATALOG_TTL_MS = 6 * 60 * 60_000;

export default createGitHubCopilotPlugin(englishPresentationText);
