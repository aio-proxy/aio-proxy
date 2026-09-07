import { expect, test } from 'bun:test';

import plugin, { OPENROUTER_PLUGIN_VERSION } from './dist/index.js';
import packageJson from './package.json' with { type: 'json' };

test('built artifact exports the OpenRouter descriptor', () => {
  expect(plugin.apiVersion).toBe(1);
  expect(OPENROUTER_PLUGIN_VERSION).toBe(packageJson.version);
});
