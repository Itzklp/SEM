import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';

import { activeRequests, requestDurationSeconds, requestErrorsTotal } from './definitions';

/**
 * Hooks are added directly on the supplied Fastify instance, not through
 * Nest's app.register() — register() creates an encapsulated child
 * context whose hooks don't apply to routes Nest registers on the root
 * instance afterward.
 *
 * Hooks must be declared callback-style `(request, reply, done) => {...}`,
 * not as plain 2-argument functions: Fastify decides how to wait for a
 * hook by its declared arity, and a 2-argument hook that doesn't
 * explicitly return a Promise hangs every request indefinitely.
 */
export function registerHttpMetrics(fastify: FastifyInstance, service: string): void {
  const startedAt = new WeakMap<FastifyRequest, bigint>();

  fastify.addHook(
    'onRequest',
    (request: FastifyRequest, _reply: FastifyReply, done: HookHandlerDoneFunction) => {
      startedAt.set(request, process.hrtime.bigint());
      activeRequests.inc({ service });
      done();
    },
  );

  fastify.addHook(
    'onResponse',
    (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
      const start = startedAt.get(request);
      startedAt.delete(request);
      // `onResponse` fires for EVERY completed response regardless of
      // whether a hook registered before this one (e.g.
      // `load-shedding.ts`, which short-circuits in its own `onRequest`)
      // ever let this one's `onRequest` run — decrementing unconditionally
      // would let `active_requests` drift negative for exactly the
      // requests that never got counted up. `start === undefined` is
      // this hook's own record of "did I actually increment for this one".
      if (start !== undefined) {
        activeRequests.dec({ service });
      }
      const durationSeconds =
        start === undefined ? 0 : Number(process.hrtime.bigint() - start) / 1e9;

      // Fastify's route PATTERN (e.g. "/fraud/cases/:id/review"), not the
      // literal path — labelling by literal path would give every distinct
      // case id its own time series, an unbounded cardinality blow-up.
      const route = request.routeOptions.url ?? 'unmatched';
      const statusCode = String(reply.statusCode);

      requestDurationSeconds.observe(
        { method: request.method, route, status_code: statusCode },
        durationSeconds,
      );
      if (reply.statusCode >= 400) {
        requestErrorsTotal.inc({ method: request.method, route, status_code: statusCode });
      }
      done();
    },
  );
}
