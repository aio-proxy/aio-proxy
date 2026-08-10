import { defineLibraryConfig, type RsbuildPlugin } from '@aio-proxy/infra/rslib';

import { buildConfigJsonSchema } from './src/config/config-json-schema.ts';

const configSchemaPlugin = (): RsbuildPlugin => ({
  name: 'aio-proxy-config-schema',
  apply: 'build',
  setup(api) {
    api.processAssets({ stage: 'additional' }, ({ sources, compilation }) => {
      const schema = buildConfigJsonSchema();
      compilation.emitAsset('config.schema.json', new sources.RawSource(JSON.stringify(schema, null, 2)));
    });
  },
});

export default defineLibraryConfig({
  plugins: [configSchemaPlugin()],
});
