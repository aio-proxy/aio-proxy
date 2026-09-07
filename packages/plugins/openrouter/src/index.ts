import packageJson from '../package.json' with { type: 'json' };
import { createOpenRouterPlugin, englishPresentationText } from './plugin/index';

export * from './catalog/index';
export * from './oauth/index';
export { createOpenRouterPlugin, englishPresentationText, type OpenRouterPresentationText } from './plugin/index';
export * from './quota/index';
export * from './runtime/index';
export * from './schema/index';

export const OPENROUTER_PLUGIN_VERSION = packageJson.version;

export default createOpenRouterPlugin(englishPresentationText);
