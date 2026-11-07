import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const code = [
  'src/**/*.{ts,tsx,js,mjs,cjs}',
  'tests/**/*.{ts,tsx,js,mjs,cjs}',
  'scripts/**/*.{js,mjs,cjs}',
  'evaluations/fixtures/**/*.mjs',
  '*.config.{ts,js,mjs,cjs}',
];

export default tseslint.config(
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'release/**',
      'runtime/**',
      'test-results/**',
      'coverage/**',
      'playwright-report/**',
      'blob-report/**',
      '.local/**',
      '.data_agent/**',
      'validation/**',
      '.husky/**',
      'docs/research/**',
      'evaluations/results/**',
    ],
  },
  {
    files: code,
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}', '*.config.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // Playwright evaluate callbacks execute in the browser, the harness in Node.
    files: ['tests/e2e/**/*.mjs', 'scripts/test/*.mjs'],
    languageOptions: { globals: globals.browser },
  },
  prettier,
);
