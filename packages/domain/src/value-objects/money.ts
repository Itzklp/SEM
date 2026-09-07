import { InvariantViolationError } from '../errors';

/**
 * Money as integer minor units (cents) plus an ISO 4217 currency code —
 * never a floating-point major-unit amount. Floating-point dollars is the
 * single most common source of silent off-by-a-cent bugs in payment
 * systems; representing the smallest unit as an integer removes the
 * category entirely.
 *
 * Immutable value object: equality is by value, and every operation
 * returns a new instance rather than mutating.
 */
export class Money {
  private constructor(
    public readonly minorUnits: number,
    public readonly currency: string,
  ) {}

  static of(minorUnits: number, currency: string): Money {
    if (!Number.isInteger(minorUnits)) {
      throw new InvariantViolationError(
        'minorUnits',
        'Money amount must be an integer number of minor units',
      );
    }
    if (minorUnits < 0) {
      throw new InvariantViolationError('minorUnits', 'Money amount cannot be negative');
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new InvariantViolationError(
        'currency',
        `Currency must be a 3-letter ISO 4217 code, got "${currency}"`,
      );
    }
    return new Money(minorUnits, currency);
  }

  /** Major-unit numeric value, for display and for feature computation only — never for storage or comparison. */
  toMajorUnits(): number {
    return this.minorUnits / 100;
  }

  equals(other: Money): boolean {
    return this.minorUnits === other.minorUnits && this.currency === other.currency;
  }

  /** Throws rather than silently comparing across currencies — a cross-currency ratio is meaningless for amount-deviation rules. */
  ratioTo(other: Money): number {
    if (this.currency !== other.currency) {
      throw new InvariantViolationError(
        'currency',
        `Cannot compare Money in different currencies: ${this.currency} vs ${other.currency}`,
      );
    }
    if (other.minorUnits === 0) {
      return Number.POSITIVE_INFINITY;
    }
    return this.minorUnits / other.minorUnits;
  }

  toString(): string {
    return `${this.toMajorUnits().toFixed(2)} ${this.currency}`;
  }
}
