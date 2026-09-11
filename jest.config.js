/**
 * Multi-project Jest configuration. Each project corresponds to one layer
 * of the test pyramid (docs/testing/test-strategy.md) and to one
 * `pnpm test:*` script — `jest --selectProjects <name>` filters to it.
 *
 * `passWithNoTests: true` on every project except `unit`: most test
 * directories are still empty scaffolding (Phase 0). A project failing CI
 * because no test exists yet would be a false signal; the traceability
 * matrix, not an empty-suite failure, is what tracks "not implemented yet".
 * `unit` is the one exception — packages/domain already has real tests,
 * and an empty result there would mean something broke.
 */

/** @type {import('ts-jest').JestConfigWithTsJest} */
const tsJestTransform = {
  '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
};

/** @type {(displayName: string, roots: string[], opts?: { needsEnv?: boolean }) => Partial<import('@jest/types').Config.InitialProjectOptions>} */
function baseProject(displayName, roots, opts = {}) {
  return {
    displayName,
    testEnvironment: 'node',
    roots,
    transform: tsJestTransform,
    moduleFileExtensions: ['ts', 'js', 'json'],
    moduleNameMapper: {
      '^@fraudguard/domain$': '<rootDir>/packages/domain/src/index.ts',
      '^@fraudguard/contracts$': '<rootDir>/packages/contracts/src/index.ts',
      '^@fraudguard/config$': '<rootDir>/packages/config/src/index.ts',
      '^@fraudguard/feature-store$': '<rootDir>/packages/feature-store/src/index.ts',
      '^@fraudguard/messaging$': '<rootDir>/packages/messaging/src/index.ts',
      '^@fraudguard/persistence$': '<rootDir>/packages/persistence/src/index.ts',
      '^@fraudguard/testkit$': '<rootDir>/packages/testkit/src/index.ts',
    },
    // Integration/E2E need real credentials (POSTGRES_PASSWORD,
    // AUTH_JWT_SECRET, ...) to call loadConfig() against real
    // infrastructure — loaded from .env locally; CI sets them as job env
    // vars directly and this file is then a no-op (see jest.setup.integration.ts).
    ...(opts.needsEnv ? { setupFiles: ['<rootDir>/jest.setup.integration.ts'] } : {}),
  };
}

module.exports = {
  // Top-level only — Jest does not honour passWithNoTests inside a
  // per-project config. Most test directories are still empty scaffolding
  // (Phase 0); an empty suite failing CI here would be a false signal —
  // the traceability matrix, not a Jest exit code, is what tracks
  // "not implemented yet".
  passWithNoTests: true,
  projects: [
    {
      ...baseProject('unit', ['<rootDir>/packages']),
      testMatch: ['**/*.test.ts'],
    },
    baseProject('architecture', ['<rootDir>/tests/architecture']),
    baseProject('integration', ['<rootDir>/tests/integration'], { needsEnv: true }),
    baseProject('contract', ['<rootDir>/tests/contract']),
    baseProject('e2e', ['<rootDir>/tests/e2e'], { needsEnv: true }),
    baseProject('resilience', ['<rootDir>/tests/resilience'], { needsEnv: true }),
  ],
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    '!packages/*/src/**/*.test.ts',
    '!packages/*/src/index.ts',
  ],
  coverageDirectory: '<rootDir>/coverage',
};
