import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export interface ModelRegistryInput {
  readonly modelVersion: string;
  readonly providerName: string;
  readonly description: string;
  readonly active: boolean;
  readonly metrics: Record<string, number> | null;
  readonly registeredAt: Date;
  readonly eventId: string;
  readonly payload: unknown;
  readonly traceContext: string | null;
}

export class ModelRegistryRepository {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async list(): Promise<readonly Record<string, unknown>[]> {
    const result = await this.db.execute(sql`
      SELECT model_version AS "modelVersion", provider_name AS "providerName",
        description, registered_at AS "registeredAt", active, metrics
      FROM model_versions ORDER BY registered_at DESC
    `);
    return result.rows;
  }

  async register(input: ModelRegistryInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (input.active) {
        await tx.execute(sql`UPDATE model_versions SET active = FALSE WHERE active = TRUE`);
      }
      await tx.execute(sql`
        INSERT INTO model_versions
          (model_version, provider_name, description, registered_at, active, metrics)
        VALUES (${input.modelVersion}, ${input.providerName}, ${input.description},
          ${input.registeredAt}, ${input.active}, ${input.metrics ? JSON.stringify(input.metrics) : null}::jsonb)
        ON CONFLICT (model_version) DO UPDATE SET
          provider_name = EXCLUDED.provider_name, description = EXCLUDED.description,
          registered_at = EXCLUDED.registered_at, active = EXCLUDED.active, metrics = EXCLUDED.metrics
      `);
      await tx.execute(sql`
        INSERT INTO outbox_events (event_id, aggregate_id, event_type, topic, partition_key, payload, trace_context)
        VALUES (${input.eventId}::uuid, ${input.modelVersion}, 'model.updated', 'model.updated',
          ${input.modelVersion}, ${JSON.stringify(input.payload)}::jsonb, ${input.traceContext})
        ON CONFLICT (event_id) DO NOTHING
      `);
    });
  }
}
