/** Postgres error code for a unique_violation — https://www.postgresql.org/docs/current/errcodes-appendix.html */
export const UNIQUE_VIOLATION = '23505';

export function hasPgErrorCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
  );
}

/**
 * "Server unreachable" codes, as opposed to "server rejected this query"
 * (unique_violation, constraint check, syntax error) — ADR-005's 503
 * fail-closed policy applies only to the first class, so the two must
 * never share a status code. Covers both Node's own connection errors
 * (ECONNREFUSED, ETIMEDOUT, ENOTFOUND, surfaced by `pg` as plain
 * NodeJS.ErrnoExceptions) and Postgres's own SQLSTATE connection-exception
 * and cannot-connect-now classes.
 */
const CONNECTIVITY_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '08007', // transaction_resolution_unknown
]);

/**
 * pg-pool's own synthetic errors for a connection that dies mid-transaction
 * (checked out via pool.connect(), not idle) carry no `.code` at all —
 * message-matching is required to catch these.
 */
const CONNECTIVITY_ERROR_MESSAGES = [
  'Connection terminated unexpectedly',
  'Client has encountered a connection error and is not queryable',
  'terminating connection due to administrator command',
];

export function isPgConnectivityError(error: unknown): boolean {
  if (hasPgErrorCode(error) && CONNECTIVITY_ERROR_CODES.has(error.code)) {
    return true;
  }
  return (
    error instanceof Error &&
    CONNECTIVITY_ERROR_MESSAGES.some((message) => error.message.includes(message))
  );
}
