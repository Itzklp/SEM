// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.turbo/**',
      'ml/**',
      '**/*.js',
      '**/*.mjs',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Explicit project list rather than `projectService: true`: the
        // service auto-discovers a tsconfig per file via each package's
        // `include`, which excludes *.test.ts (build tsconfigs must not
        // include tests — see packages/*/tsconfig.json). tsconfig.test.json
        // covers both source and test files in one project, so every file
        // resolves.
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { import: importPlugin },
    rules: {
      // --- CONTRIBUTING.md prohibitions, enforced -------------------------
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      'no-console': 'error', // use the injected logger
      'no-debugger': 'error',

      // A caught error that is neither handled nor rethrown is a silent
      // failure — the hardest kind of bug to diagnose in a distributed system.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // Interpolating a number (e.g. a score, a threshold) into a message
      // string is safe and common in this codebase's error messages —
      // the default rule flags it as if it were an unsafe `object`.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/no-cycle': 'error',
    },
  },

  // -------------------------------------------------------------------------
  // packages/domain must stay I/O-free and framework-free (ADR-004).
  //
  // This is a first line of defence for developer feedback in the editor.
  // The authoritative check is the architecture test (ADR-003), which
  // traverses the full import graph rather than direct imports only.
  // -------------------------------------------------------------------------
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'import/no-restricted-paths': 'off',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: 'packages/domain must not perform I/O (ADR-004).' },
            { name: 'ioredis', message: 'packages/domain must not perform I/O (ADR-004).' },
            { name: 'kafkajs', message: 'packages/domain must not perform I/O (ADR-004).' },
            { name: 'drizzle-orm', message: 'packages/domain must not perform I/O (ADR-004).' },
            { name: '@nestjs/common', message: 'packages/domain must stay framework-free (ADR-004).' },
            { name: '@nestjs/core', message: 'packages/domain must stay framework-free (ADR-004).' },
          ],
          patterns: [
            { group: ['node:fs', 'node:net', 'node:http*'], message: 'packages/domain must not perform I/O (ADR-004).' },
          ],
        },
      ],
    },
  },

  // Tests: relax the rules that exist to protect production code.
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },

  // Integration/E2E/resilience tests exercise real framework internals —
  // Fastify's `.inject()`/`.json()` and loosely-typed third-party response
  // shapes are inherently `any` at the type level. Unit and contract tests
  // work entirely with our own typed domain code and keep the stricter
  // default deliberately.
  {
    files: ['tests/integration/**/*.ts', 'tests/e2e/**/*.ts', 'tests/resilience/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  // NestJS module classes are conventionally empty — all they do is carry
  // @Module() metadata for the DI container. Flagging that as "extraneous"
  // would fight the framework's own idiom on every single module file.
  {
    files: ['**/*.module.ts'],
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },

  // Standalone CLI entrypoints (migration runner, etc.) — console output
  // IS the interface here, not a debugging leftover.
  {
    files: ['**/migrate.ts', '**/rollback.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  prettier,
);
