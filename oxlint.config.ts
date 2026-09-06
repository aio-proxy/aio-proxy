import logtape from '@logtape/lint/eslint';
import { defineConfig } from 'oxlint';

import { ignorePatterns } from './oxc.ts';

// oxlint 1.79 split `react/react-compiler` into 22 per-category rules. Listed as one group so
// the whole React Compiler surface stays visible and can be toggled together — several land in
// `correctness`, so leaving one out silently enables it via the category and makes the test-file
// override incomplete.
const REACT_COMPILER_RULES = [
  'capitalized-calls',
  'error-boundaries',
  'exhaustive-effect-dependencies',
  'globals',
  'hooks',
  'immutability',
  'incompatible-library',
  'invariant',
  'memo-dependencies',
  'no-deriving-state-in-effects',
  'preserve-manual-memoization',
  'purity',
  'refs',
  'rule-suppression',
  'set-state-in-effect',
  'set-state-in-render',
  'static-components',
  'syntax',
  'todo',
  'unsupported-syntax',
  'use-memo',
  'void-use-memo',
] as const;

// These two report code the aggregate rule accepted, so adopting them is a separate decision from
// the split. Pinned to 'off' rather than merely omitted, because both would otherwise arrive
// through the `correctness` category.
const REACT_COMPILER_RULES_DEFERRED = new Set<(typeof REACT_COMPILER_RULES)[number]>([
  'exhaustive-effect-dependencies',
  'rule-suppression',
]);

const reactCompilerRules = (severity: 'error' | 'off') =>
  Object.fromEntries(
    REACT_COMPILER_RULES.map((rule) => [`react/${rule}`, REACT_COMPILER_RULES_DEFERRED.has(rule) ? 'off' : severity]),
  );

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
    ...reactCompilerRules('error'),
    'react-hooks/exhaustive-deps': 'warn',
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
        'react/no-multi-comp': 'error',
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
        ...reactCompilerRules('off'),
        'max-lines-per-function': 'off',
        'max-lines': 'off',
      },
    },
  ],
  ignorePatterns,
});
