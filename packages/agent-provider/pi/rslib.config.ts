import { defineLibraryConfig } from '@aio-proxy/infra/rslib';

export default defineLibraryConfig({
  lib: [
    {
      id: 'pi-family',
      format: 'esm',
      bundle: true,
      autoExternal: false,
      dts: true,
      source: {
        entry: {
          'official-pi': './src/official-pi/index.ts',
          omp: './src/omp/index.ts',
        },
      },
      output: { distPath: { root: './dist' } },
      splitChunks: false,
      tools: {
        rspack: (config) => {
          config.optimization ??= {};
          config.optimization.splitChunks = false;
          config.optimization.runtimeChunk = false;
          config.output ??= {};
          config.output.asyncChunks = false;
          config.output.library = { type: 'module' };
          return config;
        },
      },
    },
  ],
});
