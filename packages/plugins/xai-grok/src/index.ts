import packageJson from "../package.json" with { type: "json" };
import { createXAIGrokPlugin, englishPresentationText } from "./plugin";

export * from "./catalog";
export * from "./oauth";
export { createXAIGrokPlugin, englishPresentationText, type XAIGrokPresentationText } from "./plugin";
export * from "./quota";
export * from "./runtime/index";
export * from "./schema";

export const XAI_GROK_PLUGIN_VERSION = packageJson.version;

export default createXAIGrokPlugin(englishPresentationText);
