import { mulberry32, pick, randomInt } from './prng';

/**
 * FR-018. Deterministic synthetic transaction generation: the same seed
 * produces byte-identical output, which is what makes performance and
 * detection results reproducible across runs and across teammates.
 *
 * Scope note: this generates well-formed `ScoreRequest`-shaped payloads
 * (the "normal" pattern) with deterministic identifiers and amounts —
 * sufficient for Phase 3's integration tests. The remaining fraud patterns
 * FR-018 names (high-velocity, amount-anomaly, suspicious-device,
 * suspicious-merchant, geographic-anomaly, repeated-failure, coordinated
 * rings) are meaningful once there is a feature store and rule engine to
 * detect them against (Phase 4/5) — building them earlier would mean
 * testing against nothing. Tracked in the traceability matrix as partial
 * coverage, not silently assumed complete.
 */
export interface GeneratedTransaction {
  readonly transactionId: string;
  readonly userId: string;
  readonly merchantId: string;
  readonly deviceId: string;
  readonly amount: { readonly minorUnits: number; readonly currency: string };
  readonly paymentMethod: string;
  readonly ipAddress: string;
  readonly timestamp: string;
}

export interface GeneratorOptions {
  readonly seed: number;
  readonly userCount?: number;
  readonly merchantCount?: number;
  readonly deviceCount?: number;
}

const CURRENCIES = ['USD', 'EUR', 'GBP'] as const;

/** Generates one deterministic transaction. `index` selects the position in the seeded sequence — calling with the same (seed, index) always produces the same transaction. */
export function generateTransaction(
  options: GeneratorOptions,
  index: number,
): GeneratedTransaction {
  const { seed, userCount = 10_000, merchantCount = 500, deviceCount = 15_000 } = options;
  // Mixing `index` into the seed (rather than sharing one PRNG instance
  // across calls) is what lets a caller ask for transaction #5000 directly
  // without generating the 4,999 before it — useful for tests that want
  // one specific deterministic transaction.
  const rng = mulberry32(seed ^ (index * 0x9e3779b1));

  const userId = `user_${randomInt(rng, 1, userCount)}`;
  const merchantId = `merchant_${randomInt(rng, 1, merchantCount)}`;
  const deviceId = `device_${randomInt(rng, 1, deviceCount)}`;
  const minorUnits = randomInt(rng, 500, 50_000); // $5.00 - $500.00
  const currency = pick(rng, CURRENCIES);
  const ipOctets = [
    randomInt(rng, 1, 223),
    randomInt(rng, 0, 255),
    randomInt(rng, 0, 255),
    randomInt(rng, 1, 254),
  ];

  return {
    transactionId: `txn_${seed}_${index}`,
    userId,
    merchantId,
    deviceId,
    amount: { minorUnits, currency },
    paymentMethod: `card_token_${randomInt(rng, 100000, 999999)}`,
    ipAddress: ipOctets.join('.'),
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  };
}

/** Generates `count` deterministic transactions in sequence. */
export function generateTransactions(
  options: GeneratorOptions,
  count: number,
): GeneratedTransaction[] {
  return Array.from({ length: count }, (_, i) => generateTransaction(options, i));
}
