/** Postgres error code for a unique_violation — https://www.postgresql.org/docs/current/errcodes-appendix.html */
export const UNIQUE_VIOLATION = '23505';

export function hasPgErrorCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
  );
}

/**
 * Codes meaning "the server could not be reached or is not accepting
 * connections" — as opposed to "the server rejected this query" (a
 * unique_violation, a constraint check, a syntax error). ADR-005's
 * fail-closed policy for PostgreSQL applies to the FIRST class only: a
 * 503 is the correct response to "Postgres is down," not to "this code
 * has a bug" — those two cases must never share a status code, or a real
 * bug starts silently looking like planned degradation.
 *
 * Node's own connection-level errors (`ECONNREFUSED` when nothing is
 * listening, `ETIMEDOUT`/`EHOSTUNREACH` for an unreachable host,
 * `ENOTFOUND` for DNS) are surfaced by the `pg` driver as plain
 * `NodeJS.ErrnoException`s, not as Postgres wire-protocol errors — hence
 * checking `code` against BOTH that set and the server-side SQLSTATE
 * classes for "connection exception" (`08xxx`) and "cannot connect now"
 * (`57P03`, e.g. the server still starting up / shutting down).
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
 * `pg-pool`'s OWN synthetic errors for a connection that died while
 * CHECKED OUT (not while idle) — drizzle's `.transaction()` checks out
 * one dedicated client for the whole `BEGIN...COMMIT` sequence via
 * `pool.connect()`, and when that specific client's socket closes
 * mid-transaction, `pg-pool` rejects with a plain `Error` carrying NONE
 * of the codes above — no `.code` property at all, only this message.
 * CAUGHT LIVE: this, not a coded error, is what actually came back from
 * stopping Postgres mid-transaction against a real container — checking
 * `.code` alone missed every occurrence of it.
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
