import logtape from '@logtape/lint/eslint';
import { defineConfig } from 'oxlint';

import { ignorePatterns } from './oxc.ts';

export default defineConfig({
  categories: {
    correctness: 'error',
  },
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
    'import/no-duplicates': 'error',
    'max-lines-per-function': [
      'error',
      {
        max: 120,
        IIFEs: true,
        skipBlankLines: true,
        skipComments: false,
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
            skipComments: false,
          },
        ],
      },
    },
    {
      files: ['**/*.test.tsx'],
      rules: {
        'max-lines-per-function': 'off',
      },
    },
  ],
  ignorePatterns,
});
