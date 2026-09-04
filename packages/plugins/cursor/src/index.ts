import packageJson from '../package.json' with { type: 'json' };
import { createCursorPlugin, englishPresentationText } from './plugin/index';

export * from './catalog/index';
export * from './jwt/index';
export * from './oauth/index';
export { createCursorPlugin, englishPresentationText, type CursorPresentationText } from './plugin/index';
export * from './quota/index';
export * from './runtime';
export * from './schema';
export * from './store';
export * from './wire';

export const CURSOR_PLUGIN_VERSION = packageJson.version;

export default createCursorPlugin(englishPresentationText);
