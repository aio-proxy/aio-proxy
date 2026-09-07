import packageJson from '../package.json' with { type: 'json' };
import { createMuseCodePlugin, englishPresentationText } from './plugin/index';

export * from './catalog/index';
export * from './oauth/index';
export { createMuseCodePlugin, englishPresentationText } from './plugin/index';
export * from './quota/index';
export * from './runtime/index';
export * from './schema/index';

export const MUSE_CODE_PLUGIN_VERSION = packageJson.version;

export default createMuseCodePlugin(englishPresentationText);
