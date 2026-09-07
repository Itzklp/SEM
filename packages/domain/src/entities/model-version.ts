/**
 * FR-012. A registered, versioned scoring model. Populated meaningfully
 * only from Phase 10 onward, but the shape is defined now so
 * `FraudDecision.modelVersion` (Phase 5) is a real foreign key from day
 * one — "model-v0-stub" and "model-v0-rules" are legitimate `ModelVersion`
 * rows for the stub and rule-based providers, not a special case.
 */
export interface ModelVersion {
  readonly modelVersion: string;
  readonly providerName: string;
  readonly description: string;
  readonly registeredAt: Date;
  readonly active: boolean;
  /** Present only for a genuine ML model (Phase 10) — absent for stub/rules. */
  readonly metrics: ModelMetrics | null;
}

/**
 * FR-018 §29 of the brief: accuracy alone is meaningless on imbalanced
 * fraud data. Every field here must be reported for a candidate model —
 * a model missing these cannot be compared against the baseline.
 */
export interface ModelMetrics {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly rocAuc: number;
  readonly prAuc: number;
  readonly falsePositiveRate: number;
  readonly falseNegativeRate: number;
  readonly inferenceLatencyP99Ms: number;
}
