import { defineLibraryConfig } from '@aio-proxy/infra/rslib';

export default defineLibraryConfig({
  lib: [
    {
      id: 'library',
      format: 'esm',
      bundle: false,
      dts: true,
      source: {
        entry: {
          index: [
            './src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
            '!./src/**/*.test.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
            '!./src/**/*.test-support.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
            '!./src/**/fake-native.ts',
          ],
        },
      },
      output: { distPath: { root: './dist' } },
    },
  ],
});
