import { expect, test } from 'bun:test';

test('built artifact is a self-contained V1 PluginModule', async () => {
  const code = await Bun.file(new URL('./dist/index.js', import.meta.url)).text();
  const runtimeImport =
    /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'](?:@aio-proxy\/|@opencode-ai\/plugin)/u;
  expect(runtimeImport.test(code)).toBe(false);
  const plugin = (await import(new URL('./dist/index.js', import.meta.url).href)).default;
  expect(plugin.id).toBe('aio-proxy');
  expect(typeof plugin.server).toBe('function');
  expect('effect' in plugin).toBe(false);
});
