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
export function registerLoadShedding(
  fastify: FastifyInstance,
  maxConcurrentRequests: number,
): void {
  let active = 0;
  const counted = new WeakSet<FastifyRequest>();

  fastify.addHook(
    'onRequest',
    (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
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
      // Symmetric with `registerHttpMetrics`'s own guard: `onResponse`
      // fires even for a request THIS module itself shed (never
      // incremented) — decrementing unconditionally would drift `active`
      // negative, which would eventually shed nothing at all.
      if (counted.has(request)) {
        active -= 1;
        counted.delete(request);
      }
      done();
    },
  );
}
