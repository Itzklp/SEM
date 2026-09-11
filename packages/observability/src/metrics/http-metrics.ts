import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';

import { activeRequests, requestDurationSeconds, requestErrorsTotal } from './definitions';

/**
 * Registers `request_duration_seconds`, `request_errors_total` and
 * `active_requests` directly on the SUPPLIED Fastify instance via
 * `addHook`, rather than through Nest's `app.register()` (the pattern
 * `@fastify/rate-limit` uses in `fraud-api/src/main.ts`). `register()`
 * creates a new, encapsulated child context — hooks added inside it do
 * NOT apply to sibling routes Nest registers directly on the root
 * instance afterward (`@fastify/rate-limit` only works through
 * `register()` because it internally opts out of encapsulation via
 * `fastify-plugin`). Calling `addHook` directly on the root instance
 * — exactly what `app.getHttpAdapter().getInstance()` returns — sidesteps
 * that without adding a dependency just to re-opt-out of it.
 *
 * Request start times live in a `WeakMap`, not a property assigned onto
 * `request` — this package has no reason to augment Fastify's
 * `FastifyRequest` type for one field, and a `WeakMap` needs no such
 * augmentation and is automatically released once the request object is
 * garbage-collected.
 *
 * Hooks are declared callback-style (`(request, reply, done) => {...;
 * done();}`), not as plain 2-argument functions — caught live: a
 * 2-argument hook that does not explicitly return a Promise hung EVERY
 * request indefinitely (not just `/metrics` — every route, `/health`
 * included), because Fastify's hook runner decides how to wait for a
 * hook by its declared arity: 3 arguments means "call `done()` when
 * finished"; 2 or fewer means "the return value must be a `Promise` I
 * can `.then()`". A synchronous function that returns `undefined`
 * satisfies neither — Fastify waits on a `.then()` that never resolves.
 * The 3-argument, explicit-`done()` form is unambiguous regardless of
 * that arity-detection logic, independent of Fastify's own docs also
 * supporting `async`/Promise-returning hooks.
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
      activeRequests.dec({ service });

      const start = startedAt.get(request);
      startedAt.delete(request);
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
