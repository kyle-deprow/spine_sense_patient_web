import js from '@eslint/js'
import nextPlugin from '@next/eslint-plugin-next'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: ['.next/**', 'node_modules/**', 'coverage/**', '*.config.{js,ts,mjs}'],
  },
  js.configs.recommended,
  nextPlugin.flatConfig.coreWebVitals,
  ...tseslint.configs['flat/strict'],
  reactHooks.configs['recommended-latest'],
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message: 'Patient web must not store tokens or PHI in browser storage.',
        },
        {
          name: 'sessionStorage',
          message: 'Patient web must not store tokens or PHI in browser storage.',
        },
        {
          name: 'indexedDB',
          message: 'Patient web MVP must not use durable browser PHI storage.',
        },
      ],
    },
  },
  {
    files: ['src/app/api/**/*.ts', 'src/lib/**/*.ts', 'src/middleware.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['external/spine_sense_app/**', 'external/spine_sense_api/**', 'external/spine_sense_provider/**'],
              message: 'Patient web BFF must not import sibling apps directly.',
            },
          ],
        },
      ],
    },
  },
]
