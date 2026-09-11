/** Postgres error code for a unique_violation — https://www.postgresql.org/docs/current/errcodes-appendix.html */
export const UNIQUE_VIOLATION = '23505';

export function hasPgErrorCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
  );
}
