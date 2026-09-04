import packageJson from '../package.json' with { type: 'json' };
import { createOpenAIChatGPTPlugin, englishPresentationText } from './plugin/index';

export { CHATGPT_CATALOG_TTL_MS, CODEX_MODELS_ENDPOINT } from './catalog';
export { createOpenAIChatGPTPlugin, englishPresentationText, type OpenAIChatGPTPresentationText } from './plugin/index';
export type { ChatGPTCredential } from './schema';

export const OPENAI_CHATGPT_PLUGIN_VERSION = packageJson.version;

export default createOpenAIChatGPTPlugin(englishPresentationText);
