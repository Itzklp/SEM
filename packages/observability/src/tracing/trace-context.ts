import { context, propagation, trace, type Context } from '@opentelemetry/api';

/**
 * Carries a W3C `traceparent` string across the one gap OpenTelemetry's
 * own context propagation cannot bridge on its own: the transactional
 * outbox (ADR-006). A Kafka header survives a produce-to-consume hop
 * automatically once it's set on the message — but the outbox relay
 * publishes that message in a DIFFERENT PROCESS, at a LATER TIME, than
 * the HTTP request that originally created the span. Without persisting
 * the traceparent alongside the outbox row itself
 * (`outbox_events.trace_context`, migration 0003), the relay would start
 * a brand-new, disconnected trace for every publish — "a single
 * transaction is traceable end to end by traceId" (this phase's exit
 * criterion) would be false for exactly the part of the system ADR-006
 * exists to decouple.
 */

/** Called in `apps/fraud-api/src/scoring/build-outbox-events.ts`, inside the active request span, so the captured value is THIS request's traceparent — not the relay's, which hasn't started yet. */
export function captureTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier['traceparent'];
}

/** The active span's trace id alone (not the full `traceparent` string) — what `@fraudguard/contracts`' event envelopes put in their own public `traceId` field, replacing `build-outbox-events.ts`'s former placeholder (`transactionId`) now that real tracing exists. `undefined` when tracing is disabled or nothing is active — callers fall back to something else (e.g. `transactionId`) rather than writing "undefined" into a correlation field. */
export function currentTraceId(): string | undefined {
  return trace.getActiveSpan()?.spanContext().traceId;
}

/**
 * Runs `fn` with `traceparent` (if present) extracted into the active
 * context, so any span started inside `fn` becomes a CHILD of the
 * original request's trace — even though that original request returned
 * its response minutes of wall-clock time ago. OpenTelemetry traces have
 * no real-time constraint on this: a trace is just a set of spans
 * sharing a trace ID, however far apart their timestamps are, as long as
 * every span reaches the same backend (Jaeger) eventually.
 *
 * A missing/undefined traceparent (older rows from before migration
 * 0003, or tracing disabled when the row was written) degrades to "start
 * a fresh, disconnected span" rather than throwing — the relay and
 * consumers must keep running whether or not tracing context survived.
 */
export function runWithExtractedContext<T>(traceparent: string | undefined, fn: () => T): T {
  if (!traceparent) {
    return fn();
  }
  const extracted: Context = propagation.extract(context.active(), { traceparent });
  return context.with(extracted, fn);
}
