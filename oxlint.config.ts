import logtape from '@logtape/lint/eslint';
import { defineConfig } from 'oxlint';

import { ignorePatterns } from './oxc.ts';

export default defineConfig({
  categories: {
    correctness: 'error',
  },
  plugins: ['react'],
  jsPlugins: [{ name: 'logtape', specifier: '@logtape/lint/eslint' }],
  rules: {
    'unicorn/filename-case': [
      'warn',
      {
        cases: {
          kebabCase: true,
          snakeCase: true,
        },
      },
    ],
    'unicorn/no-nested-ternary': 'error',
    'react/no-multi-comp': 'error',
    'react-hooks/exhaustive-deps': 'off',
    'import/no-duplicates': 'error',
    'max-lines-per-function': [
      'error',
      {
        max: 160,
        IIFEs: true,
        skipBlankLines: true,
        skipComments: true,
      },
    ],
    'max-lines': [
      'error',
      {
        max: 500,
        skipBlankLines: true,
        skipComments: false,
      },
    ],
    'typescript/no-deprecated': 'error',
    'typescript/consistent-type-imports': 'error',
    ...logtape.configs.recommended.rules,
  },
  overrides: [
    {
      files: ['**/*.tsx'],
      rules: {
        'max-lines-per-function': [
          'error',
          {
            max: 300,
            IIFEs: true,
            skipBlankLines: true,
            skipComments: true,
          },
        ],
      },
    },
    {
      files: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'],
      rules: {
        'max-lines-per-function': 'off',
        'max-lines': 'off',
      },
    },
  ],
  ignorePatterns,
});
