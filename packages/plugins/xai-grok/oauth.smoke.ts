import { expect, test } from 'bun:test';

import plugin, { XAI_GROK_PLUGIN_VERSION } from './dist/index.js';
import packageJson from './package.json' with { type: 'json' };

test('built artifact exports the xAI Grok descriptor', () => {
  expect(plugin.apiVersion).toBe(2);
  expect(XAI_GROK_PLUGIN_VERSION).toBe(packageJson.version);
});
