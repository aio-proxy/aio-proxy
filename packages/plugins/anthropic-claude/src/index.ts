import packageJson from '../package.json' with { type: 'json' };
import { createAnthropicClaudePlugin, englishPresentationText } from './plugin';

export * from './catalog';
export * from './oauth';
export { createAnthropicClaudePlugin, englishPresentationText, type ClaudePresentationText } from './plugin';
export * from './runtime/index';
export * from './schema';

export const CLAUDE_PLUGIN_VERSION = packageJson.version;

export default createAnthropicClaudePlugin(englishPresentationText);
