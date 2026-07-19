import packageJson from "../package.json" with { type: "json" };
import { createKimiCodePlugin, englishPresentationText } from "./plugin";

export * from "./catalog";
export * from "./headers";
export * from "./oauth";
export {
  createKimiCodePlugin,
  englishPresentationText,
  type KimiCodePresentationText,
} from "./plugin";
export * from "./quota";
export * from "./runtime";

export const KIMI_CODE_PLUGIN_VERSION = packageJson.version;

export default createKimiCodePlugin(englishPresentationText);
