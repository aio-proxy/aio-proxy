import { defineConfig } from 'oxfmt';

import { ignorePatterns } from './oxc.ts';

export default defineConfig({
  singleQuote: true,
  printWidth: 120,
  sortPackageJson: false,
  sortImports: true,
  overrides: [
    {
      files: ['packages/dashboard/**/*.{js,jsx,ts,tsx}'],
      options: {
        sortTailwindcss: {
          stylesheet: 'packages/dashboard/src/styles.css',
          functions: ['clsx', 'cn', 'cva', 'tw'],
        },
      },
    },
  ],
  ignorePatterns,
});
