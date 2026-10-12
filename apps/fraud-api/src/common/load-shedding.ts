import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';

/**
 * ADR-005's "Overload" row: "Shed above a concurrency ceiling with `429`
 * and `Retry-After`." `AppConfig.security.maxConcurrentRequests`
 * (`MAX_CONCURRENT_REQUESTS`) has existed since Phase 1 — CAUGHT WRITING
 * PHASE 8's resilience suite: nothing ever actually READ it. The
 * `@fastify/rate-limit` plugin already registered in `main.ts` enforces
 * a DIFFERENT thing — requests per time window, keyed per client — not a
 * concurrency ceiling. This is the missing piece: how many requests
 * `fraud-api` will work on AT ONCE, regardless of which client they're
 * from or how spread out in time they arrived.
 *
 * A plain closure-scoped counter, not the `active_requests` Prometheus
 * gauge (`packages/observability`) — reading a gauge's current value
 * back out is a metrics-library operation with per-call overhead this
 * hot-path check shouldn't pay for just to reuse a number that's trivial
 * to keep locally instead.
 */
// Exempt from the ceiling: an operator diagnosing an incident (which is
// exactly when this ceiling is most likely to be engaged) must always be
// able to reach `/health` and `/metrics`, and Prometheus's own scrape must
// never itself become a casualty of the thing it exists to detect.
const EXEMPT_ROUTES = new Set(['/metrics', '/api/v1/health']);

export function registerLoadShedding(
  fastify: FastifyInstance,
  maxConcurrentRequests: number,
): void {
  let active = 0;
  const counted = new WeakSet<FastifyRequest>();

  function release(request: FastifyRequest): void {
    if (counted.has(request)) {
      active -= 1;
      counted.delete(request);
    }
  }

  fastify.addHook(
    'onRequest',
    (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
      if (EXEMPT_ROUTES.has(request.url.split('?')[0] ?? request.url)) {
        done();
        return;
      }
      // CAUGHT LIVE, Phase 9: a client that aborts mid-response (k6's own
      // request timeout killing the socket under heavy load, or any real
      // client doing the same) does not reliably fire Fastify's
      // `onResponse` hook — the request lifecycle never reaches "sent".
      // Without this fallback, every aborted request leaks one count
      // permanently, and `active` ratchets up until the ceiling is
      // engaged forever, long after real traffic has stopped (confirmed:
      // `/health` kept returning 429 for over a minute after the load
      // generator had already exited). `reply.raw`'s own 'close' event
      // fires in every case `onResponse` does NOT catch — guarded by the
      // same `counted` WeakSet so a request that completes normally is
      // never double-released.
      reply.raw.on('close', () => {
        release(request);
      });

      if (active >= maxConcurrentRequests) {
        // Sending the reply directly from the hook, without calling
        // `done()`, is how Fastify short-circuits the request — no
        // further hooks (including `registerHttpMetrics`'s, registered
        // after this one in main.ts) or the route handler run.
        void reply
          .header('Retry-After', '1')
          .code(429)
          .send({
            error: {
              code: 'OVERLOADED',
              message: 'Too many requests in flight. Retry shortly.',
              requestId: request.id,
            },
          });
        return;
      }
      active += 1;
      counted.add(request);
      done();
    },
  );

  fastify.addHook(
    'onResponse',
    (request: FastifyRequest, _reply: FastifyReply, done: HookHandlerDoneFunction) => {
      // The common case — a response that completed normally. `release`
      // itself is guarded (via `counted`) against the request having
      // already been released by the `'close'` fallback above, and
      // against a request this module shed and never counted at all.
      release(request);
      done();
    },
  );
}
