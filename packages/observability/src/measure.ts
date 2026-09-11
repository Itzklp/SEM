import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import type { Histogram } from 'prom-client';

/**
 * One tracer for the whole process, named after the project rather than
 * per-file — OpenTelemetry's own convention is "one tracer per
 * instrumentation library", and here that library IS this package.
 */
const tracer = trace.getTracer('fraudguard');

export interface MeasureOptions<L extends string> {
  /** Span name — convention: `<component>.<operation>`, e.g. `redis.feature_fetch`, `db.insert_scored`. */
  readonly span: string;
  readonly histogram: Histogram<L>;
  readonly labels: Record<L, string>;
  readonly attributes?: Attributes;
}

/**
 * The one measurement point this package asks every I/O call site to use
 * — a span AND the matching Prometheus histogram observation, from a
 * single timer, so the two numbers can never disagree about what counts
 * as "the operation" (see `tracing.ts`'s doc comment on why this replaces
 * auto-instrumentation here). `tracer.startActiveSpan` makes the new span
 * the active one in context for the duration of `fn` — a span started
 * inside `fn` (e.g. a nested repository call) becomes its child
 * automatically, with no explicit parent-passing required.
 */
export async function measure<T, L extends string>(
  options: MeasureOptions<L>,
  fn: () => Promise<T>,
): Promise<T> {
  const endTimer = options.histogram.startTimer(options.labels);
  return tracer.startActiveSpan(options.span, async (span) => {
    if (options.attributes) {
      span.setAttributes(options.attributes);
    }
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      endTimer();
      span.end();
    }
  });
}

/** Span-only variant for operations with no matching Prometheus metric in the roadmap's list (the outbox relay's publish span, Kafka consumers' per-message span) — same error/status handling as `measure()`, without a histogram to double as. */
export async function withSpan<T>(
  name: string,
  attributes: Attributes | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    if (attributes) {
      span.setAttributes(attributes);
    }
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
