import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';

/**
 * ADR-005's overload row: shed above a concurrency ceiling with 429 +
 * Retry-After. This is distinct from @fastify/rate-limit (requests per
 * window, per client) — a plain in-flight count, regardless of client.
 * Uses a closure-scoped counter rather than reading back the
 * active_requests Prometheus gauge, to avoid that per-call overhead on the hot path.
 */
// /health and /metrics stay reachable even while shedding, so an operator
// diagnosing the incident (and Prometheus's own scrape) isn't a casualty of it.
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
      // A client that aborts mid-response never fires onResponse, which would
      // otherwise leak this count forever — reply.raw's 'close' event covers that case.
      reply.raw.on('close', () => {
        release(request);
      });

      if (active >= maxConcurrentRequests) {
        // Replying without calling done() short-circuits the request —
        // no later hooks or the route handler run.
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
      release(request);
      done();
    },
  );
}
