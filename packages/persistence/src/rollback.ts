/**
 * Rolls back the single most recently applied migration, using its
 * `.down.sql` counterpart. Usage: pnpm db:rollback
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '@fraudguard/config';
import { config as loadEnvFile } from 'dotenv';
import { Client } from 'pg';

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
    const result = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY applied_at DESC LIMIT 1',
    );
    const last = result.rows[0];
    if (!last) {
      console.log('No migrations to roll back.');
      return;
    }

    const downFile = last.filename.replace(/\.sql$/, '.down.sql');
    const sql = readFileSync(join(MIGRATIONS_DIR, downFile), 'utf-8');

    console.log(`Rolling back ${last.filename} (via ${downFile})...`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('DELETE FROM schema_migrations WHERE filename = $1', [last.filename]);
      await client.query('COMMIT');
      console.log(`  ✓ rolled back ${last.filename}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Rollback of ${last.filename} failed: ${String(error)}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
