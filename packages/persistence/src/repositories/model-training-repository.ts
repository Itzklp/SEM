import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export interface TrainingFeaturesInput {
  readonly transactionId: string;
  readonly amountMajorUnits: number;
  readonly features: Record<string, number>;
  readonly predictedDecision: string;
  readonly modelVersion: string;
}

/** Joins decisions and analyst outcomes despite cross-topic delivery order. */
export class ModelTrainingRepository {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async recordFeatures(input: TrainingFeaturesInput): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO model_training_examples
        (transaction_id, amount_major_units, features, predicted_decision, model_version)
      VALUES (${input.transactionId}, ${input.amountMajorUnits}, ${JSON.stringify(input.features)}::jsonb,
        ${input.predictedDecision}, ${input.modelVersion})
      ON CONFLICT (transaction_id) DO UPDATE SET
        amount_major_units = EXCLUDED.amount_major_units,
        features = EXCLUDED.features,
        predicted_decision = EXCLUDED.predicted_decision,
        model_version = EXCLUDED.model_version,
        updated_at = NOW()
    `);
  }

  async recordReview(transactionId: string, action: 'APPROVE' | 'BLOCK'): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO model_training_examples (transaction_id, label, label_source, labeled_at)
      VALUES (${transactionId}, ${action === 'BLOCK'}, 'analyst_review', NOW())
      ON CONFLICT (transaction_id) DO UPDATE SET
        label = EXCLUDED.label, label_source = EXCLUDED.label_source,
        labeled_at = EXCLUDED.labeled_at, updated_at = NOW()
    `);
  }
}
