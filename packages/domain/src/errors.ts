/**
 * Domain error taxonomy. CONTRIBUTING.md prohibits bare `throw new Error(string)`
 * for domain failures — every failure the domain can produce is one of these
 * named, typed classes, so a catch site can discriminate on `instanceof`
 * rather than parsing a message string.
 */

/** Base for every error this package throws. Never thrown directly. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A value object or entity was constructed with data that violates an
 * invariant (e.g. a negative amount, an empty transaction id).
 * Maps to HTTP 400 at the API boundary.
 */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';

  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A lifecycle transition was attempted that the state machine does not
 * permit (e.g. reviewing an already-closed case). This is what backs the
 * "illegal transitions are rejected" acceptance criteria on FR-011.
 */
export class IllegalTransitionError extends DomainError {
  readonly code = 'ILLEGAL_TRANSITION';

  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly entity: string,
  ) {
    super(`${entity}: cannot transition from ${from} to ${to}`);
  }
}

/**
 * A proposed `RiskPolicy` fails `isValidRiskPolicy` — e.g. no REVIEW band,
 * or a degraded policy looser than the healthy one (ADR-005). FR-006:
 * runtime policy changes go through this same check `packages/config`'s
 * loader applies at boot, so a bad value cannot be adopted at runtime
 * either, just because it arrived later.
 */
export class InvalidPolicyError extends DomainError {
  readonly code = 'INVALID_POLICY';

  // Widens `DomainError`'s `protected` constructor to `public` — not
  // useless despite the identical body, since `InvalidPolicyError` (unlike
  // `InvariantViolationError`/`IllegalTransitionError`) needs no extra
  // fields and would otherwise inherit `protected`, which blocks
  // `new InvalidPolicyError(...)` from outside this package.
  public constructor(message: string) {
    super(message);
  }
}
