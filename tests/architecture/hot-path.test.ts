import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ADR-003 enforcement. A documented hot-path convention that nothing
 * checks decays the moment three developers are working in parallel — this
 * is what catches the violation at the moment it's introduced rather than
 * discovered in Phase 9. Independent of (and a backstop for) the ESLint
 * `no-restricted-imports` rule scoped to `packages/domain` — belt and
 * suspenders, same pattern used elsewhere in this project (e.g. the
 * DB-level unique constraint beneath the Redis idempotency check).
 */

const ROOT = join(__dirname, '..', '..');

function listTsFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue;
      results.push(...listTsFiles(full));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.spec.ts')
    ) {
      results.push(full);
    }
  }
  return results;
}

function importsIn(file: string): string[] {
  const content = readFileSync(file, 'utf-8');
  const matches = content.matchAll(/from\s+['"]([^'"]+)['"]/g);
  return Array.from(matches, (m) => m[1] ?? '');
}

describe('ADR-003: packages/domain stays I/O-free and framework-free', () => {
  const domainFiles = listTsFiles(join(ROOT, 'packages', 'domain', 'src'));
  const FORBIDDEN = [
    'pg',
    'ioredis',
    'kafkajs',
    'drizzle-orm',
    '@nestjs/common',
    '@nestjs/core',
    'node:fs',
    'node:net',
    'node:http',
  ];

  it('found domain source files to check (sanity check on the test itself)', () => {
    expect(domainFiles.length).toBeGreaterThan(0);
  });

  it.each(domainFiles.map((f) => [f.replace(ROOT, ''), f] as const))(
    '%s imports no I/O or framework module',
    (_label, file) => {
      const imports = importsIn(file);
      const violations = imports.filter((imp) =>
        FORBIDDEN.some((forbidden) => imp === forbidden || imp.startsWith(`${forbidden}/`)),
      );
      expect(violations).toEqual([]);
    },
  );
});

describe('ADR-001/ADR-003: the hot path (fraud-api scoring/health) never touches Kafka', () => {
  const hotPathDirs = ['scoring', 'health'].map((d) => join(ROOT, 'apps', 'fraud-api', 'src', d));
  const hotPathFiles = hotPathDirs.flatMap(listTsFiles);

  it('found fraud-api hot-path files to check (sanity check on the test itself)', () => {
    expect(hotPathFiles.length).toBeGreaterThan(0);
  });

  it.each(hotPathFiles.map((f) => [f.replace(ROOT, ''), f] as const))(
    '%s does not import kafkajs',
    (_label, file) => {
      const imports = importsIn(file);
      expect(imports).not.toContain('kafkajs');
    },
  );
});

describe('ADR-003: fraud-api reaches PostgreSQL only through packages/persistence', () => {
  const scoringFiles = listTsFiles(join(ROOT, 'apps', 'fraud-api', 'src', 'scoring'));

  it.each(scoringFiles.map((f) => [f.replace(ROOT, ''), f] as const))(
    '%s does not import pg or drizzle-orm directly',
    (_label, file) => {
      const imports = importsIn(file);
      const violations = imports.filter((imp) => imp === 'pg' || imp.startsWith('drizzle-orm'));
      expect(violations).toEqual([]);
    },
  );
});
