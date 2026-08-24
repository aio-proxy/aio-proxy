import { defineLibraryConfig } from '@aio-proxy/infra/rslib';

export default defineLibraryConfig({
  lib: [
    {
      id: 'runtime',
      format: 'esm',
      bundle: true,
      autoExternal: false,
      dts: true,
      source: { entry: { index: './src/index.ts' } },
      output: { distPath: { root: './dist' } },
    },
  ],
});
