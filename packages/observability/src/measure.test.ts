import { context, trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { Histogram } from 'prom-client';

import { measure, withSpan } from './measure';
import { captureTraceparent, runWithExtractedContext } from './tracing/trace-context';

describe('measure()', () => {
  const histogram = new Histogram({
    name: 'test_duration_seconds',
    help: 'test',
    labelNames: ['op'],
  });

  it('records a histogram observation for a successful call', async () => {
    const before = (await histogram.get()).values.find((v) => v.labels.op === 'ok')?.value ?? 0;
    await measure({ span: 'test.op', histogram, labels: { op: 'ok' } }, () =>
      Promise.resolve('result'),
    );
    const after = (await histogram.get()).values.find(
      (v) => v.metricName === 'test_duration_seconds_count' && v.labels.op === 'ok',
    )?.value;
    expect(after).toBeGreaterThan(before);
  });

  it('still records the observation and rethrows when fn fails', async () => {
    await expect(
      measure({ span: 'test.op', histogram, labels: { op: 'fail' } }, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const count = (await histogram.get()).values.find(
      (v) => v.metricName === 'test_duration_seconds_count' && v.labels.op === 'fail',
    )?.value;
    expect(count).toBe(1);
  });

  it('returns the wrapped function result', async () => {
    const result = await measure({ span: 'test.op', histogram, labels: { op: 'ok' } }, () =>
      Promise.resolve(42),
    );
    expect(result).toBe(42);
  });
});

describe('withSpan()', () => {
  it('returns the wrapped function result and rethrows on failure', async () => {
    await expect(withSpan('test.span', undefined, () => Promise.resolve('ok'))).resolves.toBe('ok');
    await expect(
      withSpan('test.span', undefined, () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
  });
});

describe('trace context propagation across the outbox gap', () => {
  // A real (if exporter-less) tracer provider — `trace.getTracer()`
  // resolves to a no-op tracer, producing all-zero span/trace ids, until
  // SOME provider is registered globally. `startTracing()` (tracing.ts)
  // is what does this in a real process; this mirrors just enough of it
  // — provider + context manager + propagator, no OTLP exporter — to
  // make this test meaningful without a live collector.
  const provider = new BasicTracerProvider();

  beforeAll(() => {
    provider.register({
      contextManager: new AsyncHooksContextManager().enable(),
      propagator: new W3CTraceContextPropagator(),
    });
  });

  it('captures undefined when there is no active span', () => {
    expect(captureTraceparent()).toBeUndefined();
  });

  it('round-trips a traceparent: captured inside one span, extracted and linked into another', () => {
    const tracer = trace.getTracer('test');
    let captured: string | undefined;

    tracer.startActiveSpan('original-request', (span) => {
      captured = captureTraceparent();
      span.end();
    });

    expect(captured).toBeDefined();
    const originalTraceId = captured?.split('-')[1];

    runWithExtractedContext(captured, () => {
      tracer.startActiveSpan('relay-publish', (span) => {
        const spanContext = span.spanContext();
        // The whole point: a span started inside the extracted context
        // belongs to the SAME trace as the original request's span, even
        // though nothing here shares a call stack with it.
        expect(spanContext.traceId).toBe(originalTraceId);
        span.end();
      });
    });
  });

  it('falls through to an ordinary call when traceparent is undefined — never throws', () => {
    expect(() => runWithExtractedContext(undefined, () => 'ran')).not.toThrow();
    expect(runWithExtractedContext(undefined, () => 'ran')).toBe('ran');
  });

  afterAll(async () => {
    await provider.shutdown();
    context.disable();
  });
});
