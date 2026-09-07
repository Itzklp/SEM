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

/** @type {(displayName: string, roots: string[]) => Partial<import('@jest/types').Config.InitialProjectOptions>} */
function baseProject(displayName, roots) {
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
    },
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
    baseProject('integration', ['<rootDir>/tests/integration']),
    baseProject('contract', ['<rootDir>/tests/contract']),
    baseProject('e2e', ['<rootDir>/tests/e2e']),
    baseProject('resilience', ['<rootDir>/tests/resilience']),
  ],
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    '!packages/*/src/**/*.test.ts',
    '!packages/*/src/index.ts',
  ],
  coverageDirectory: '<rootDir>/coverage',
};
