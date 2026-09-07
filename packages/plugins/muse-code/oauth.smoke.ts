import { expect, test } from 'bun:test';

import plugin, { MUSE_CODE_PLUGIN_VERSION } from './dist/index.js';
import packageJson from './package.json' with { type: 'json' };

test('built artifact exports the Muse Code descriptor', () => {
  expect(plugin.apiVersion).toBe(1);
  expect(MUSE_CODE_PLUGIN_VERSION).toBe(packageJson.version);
});
