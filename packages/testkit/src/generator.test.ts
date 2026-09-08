import { generateTransaction, generateTransactions } from './generator';

describe('generateTransaction', () => {
  // What: identical (seed, index) produces byte-identical output.
  // Why: FR-018's central requirement — this is what makes a load-test run
  //      or a detection-quality measurement reproducible by a teammate.
  // Catches: any accidental non-determinism (Date.now(), Math.random,
  //          object key ordering) creeping into the generator.
  it('UT-GEN-001: same seed and index produce an identical transaction', () => {
    const a = generateTransaction({ seed: 42 }, 7);
    const b = generateTransaction({ seed: 42 }, 7);
    expect(a).toEqual(b);
  });

  it('different seeds produce different transactions at the same index', () => {
    const a = generateTransaction({ seed: 42 }, 0);
    const b = generateTransaction({ seed: 43 }, 0);
    expect(a).not.toEqual(b);
  });

  it('different indices produce different transactions for the same seed', () => {
    const a = generateTransaction({ seed: 42 }, 0);
    const b = generateTransaction({ seed: 42 }, 1);
    expect(a.transactionId).not.toBe(b.transactionId);
  });

  it('produces a well-formed amount and currency', () => {
    const txn = generateTransaction({ seed: 1 }, 0);
    expect(Number.isInteger(txn.amount.minorUnits)).toBe(true);
    expect(txn.amount.minorUnits).toBeGreaterThan(0);
    expect(['USD', 'EUR', 'GBP']).toContain(txn.amount.currency);
  });

  it('respects userCount/merchantCount/deviceCount bounds', () => {
    const txn = generateTransaction({ seed: 1, userCount: 5, merchantCount: 3, deviceCount: 2 }, 0);
    expect(Number(txn.userId.split('_')[1])).toBeLessThanOrEqual(5);
    expect(Number(txn.merchantId.split('_')[1])).toBeLessThanOrEqual(3);
    expect(Number(txn.deviceId.split('_')[1])).toBeLessThanOrEqual(2);
  });
});

describe('generateTransactions', () => {
  it('generates the requested count, each with a unique transactionId', () => {
    const batch = generateTransactions({ seed: 99 }, 50);
    expect(batch).toHaveLength(50);
    expect(new Set(batch.map((t) => t.transactionId)).size).toBe(50);
  });

  // What: a full batch is reproducible, not just a single transaction.
  // Why: a load test replays thousands of generated transactions — the
  //      whole sequence must be reproducible, not just one sample of it.
  it('a full batch is reproducible across separate calls', () => {
    const first = generateTransactions({ seed: 7 }, 20);
    const second = generateTransactions({ seed: 7 }, 20);
    expect(first).toEqual(second);
  });
});
