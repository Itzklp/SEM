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
