import { InvariantViolationError } from '../errors';

import { Money } from './money';

describe('Money', () => {
  // What: integer minor-unit construction succeeds; non-integers are rejected.
  // Why: floating-point major-unit amounts are the classic source of silent
  //      off-by-a-cent bugs in payment systems.
  // Catches: a caller passing a float (e.g. 19.99) instead of minor units (1999).
  it('accepts a valid integer minor-unit amount', () => {
    const m = Money.of(1999, 'USD');
    expect(m.minorUnits).toBe(1999);
    expect(m.toMajorUnits()).toBeCloseTo(19.99);
  });

  it('rejects a non-integer amount', () => {
    expect(() => Money.of(19.99, 'USD')).toThrow(InvariantViolationError);
  });

  it('rejects a negative amount', () => {
    expect(() => Money.of(-100, 'USD')).toThrow(InvariantViolationError);
  });

  it('rejects a malformed currency code', () => {
    expect(() => Money.of(100, 'us')).toThrow(InvariantViolationError);
    expect(() => Money.of(100, 'USDX')).toThrow(InvariantViolationError);
  });

  // What: cross-currency ratio computation.
  // Why: AmountDeviationRule (Phase 5) will compute amount / average_amount_24h;
  //      silently comparing USD to EUR would produce a meaningless risk score.
  // Catches: a currency-mismatch bug that would otherwise surface only as a
  //          wrong fraud decision in production, with no error anywhere.
  it('throws when computing a ratio across different currencies', () => {
    const usd = Money.of(1000, 'USD');
    const eur = Money.of(1000, 'EUR');
    expect(() => usd.ratioTo(eur)).toThrow(InvariantViolationError);
  });

  it('computes ratio correctly within the same currency', () => {
    const large = Money.of(5000, 'USD');
    const small = Money.of(1000, 'USD');
    expect(large.ratioTo(small)).toBe(5);
  });

  it('returns Infinity when dividing by zero minor units', () => {
    const amount = Money.of(1000, 'USD');
    const zero = Money.of(0, 'USD');
    expect(amount.ratioTo(zero)).toBe(Number.POSITIVE_INFINITY);
  });

  it('equals compares by value, not identity', () => {
    expect(Money.of(500, 'USD').equals(Money.of(500, 'USD'))).toBe(true);
    expect(Money.of(500, 'USD').equals(Money.of(501, 'USD'))).toBe(false);
    expect(Money.of(500, 'USD').equals(Money.of(500, 'EUR'))).toBe(false);
  });
});
