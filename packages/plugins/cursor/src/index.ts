import packageJson from '../package.json' with { type: 'json' };
import { createCursorPlugin, englishPresentationText } from './plugin';

export * from './catalog';
export * from './jwt';
export * from './oauth';
export { createCursorPlugin, englishPresentationText, type CursorPresentationText } from './plugin';
export * from './runtime';
export * from './schema';
export * from './store';
export * from './wire';

export const CURSOR_PLUGIN_VERSION = packageJson.version;

export default createCursorPlugin(englishPresentationText);
