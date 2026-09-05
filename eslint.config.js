import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', 'docs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['apps/admin/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['apps/agent/public/**/*.js'],
    languageOptions: { globals: { ...globals.browser }, parserOptions: { sourceType: 'script' } },
    rules: { 'no-console': 'off', '@typescript-eslint/no-unused-vars': 'off' },
  },
  {
    // Command-line entry points: their whole job is to print to stdout.
    files: [
      'scripts/**/*.mjs',
      '**/*.config.{js,ts}',
      'apps/api/src/db/migrate.ts',
      'apps/api/src/db/seed.ts',
      'apps/api/src/openapi/emit.ts',
      'apps/api/src/config.ts',
      'apps/agent/src/config.ts',
    ],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/tests/**/*.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
);
