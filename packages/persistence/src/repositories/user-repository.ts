import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly role: 'customer' | 'admin';
  readonly privileges: readonly string[];
}

export class UserRepository {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async findByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.db.execute(sql`
      SELECT id, email, password_hash AS "passwordHash", display_name AS "displayName",
        role, privileges
      FROM users WHERE email = ${email}
    `);
    const row = result.rows[0];
    return row ? (row as unknown as UserRecord) : null;
  }
}
