// Flat ESLint config (ESLint 9+).
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  // Never lint build output or dependencies. bench/ holds standalone dev scripts.
  globalIgnores(['build/', 'coverage/', 'node_modules/', 'bench/']),

  // Baseline JavaScript + TypeScript recommended rules.
  eslint.configs.recommended,
  tseslint.configs.recommended,

  // Turns off stylistic rules that would conflict with Prettier.
  prettier,

  {
    rules: {
      // IMPORTANT: stdout is the MCP protocol channel (JSON-RPC over stdio).
      // A stray console.log would corrupt it, so only stderr-based logging is allowed.
      'no-console': ['error', { allow: ['error', 'warn'] }],

      // Allow intentionally unused arguments prefixed with an underscore.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
