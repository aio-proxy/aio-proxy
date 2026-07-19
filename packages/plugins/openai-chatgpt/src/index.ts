import packageJson from "../package.json" with { type: "json" };
import { createOpenAIChatGPTPlugin, englishPresentationText } from "./plugin";

export { CHATGPT_CATALOG_TTL_MS, CODEX_MODELS_URL } from "./catalog";
export { createOpenAIChatGPTPlugin, englishPresentationText, type OpenAIChatGPTPresentationText } from "./plugin";
export type { ChatGPTCredential } from "./schema";

export const OPENAI_CHATGPT_PLUGIN_VERSION = packageJson.version;

export default createOpenAIChatGPTPlugin(englishPresentationText);
