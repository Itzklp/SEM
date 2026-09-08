/**
 * CLI migration runner — deliberately NOT drizzle-kit. A hand-written SQL
 * file per migration (see migrations/*.sql) plus this small runner is more
 * transparent than a generator/push tool for a project this size (CON-006:
 * no unjustified technology) — drizzle-orm is still used for typed query
 * building in repositories; this runner only applies raw SQL and tracks
 * what's been applied in `schema_migrations`.
 *
 * Usage: pnpm db:migrate
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '@fraudguard/config';
import { config as loadEnvFile } from 'dotenv';
import { Client } from 'pg';

// Run directly via `ts-node` (pnpm db:migrate), not through Jest's
// setupFiles — needs its own .env load. Never overrides an already-set
// process.env value (dotenv default), so CI's job-level env vars still win.
loadEnvFile({ path: join(__dirname, '..', '..', '..', '.env') });

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new Client({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    password: config.postgres.password,
    ssl: config.postgres.ssl,
  });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const applied = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
        (r) => r.filename,
      ),
    );

    // Only "up" files — down.sql is applied by rollback.ts, never here.
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort();

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
      console.log(`Applying ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        appliedCount += 1;
        console.log(`  ✓ ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${String(error)}`);
      }
    }

    console.log(
      appliedCount === 0 ? 'No pending migrations.' : `Applied ${appliedCount} migration(s).`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
