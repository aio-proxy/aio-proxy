import packageJson from '../package.json' with { type: 'json' };
import { createClaudeCodePlugin, englishPresentationText } from './plugin';

export * from './catalog';
export * from './oauth';
export { createClaudeCodePlugin, englishPresentationText, type ClaudePresentationText } from './plugin';
export * from './runtime/index';
export * from './schema';

export const CLAUDE_CODE_PLUGIN_VERSION = packageJson.version;

export default createClaudeCodePlugin(englishPresentationText);
