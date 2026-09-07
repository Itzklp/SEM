import { z } from 'zod';

import { defineEvent } from './envelope';
import { transactionReceivedEvent } from './transaction-events';

describe('event envelope', () => {
  const TestEvent = defineEvent('test.event', z.object({ value: z.number() }));

  function envelopeFields() {
    return {
      eventId: '123e4567-e89b-12d3-a456-426614174000',
      aggregateId: 'txn_123',
      occurredAt: '2026-09-07T12:00:00Z',
      traceId: 'trace-abc',
    };
  }

  it('accepts a well-formed event of the declared type', () => {
    const result = TestEvent.safeParse({
      ...envelopeFields(),
      eventType: 'test.event',
      payload: { value: 1 },
    });
    expect(result.success).toBe(true);
  });

  // What: eventType is a literal, not a free string.
  // Why: this is what lets a consumer routing on eventType get a
  //      compile-time-narrowed payload type via a discriminated union,
  //      and what stops a producer from publishing a mislabelled event
  //      onto a topic (a schema for the wrong event type must fail).
  it('rejects a mismatched eventType literal', () => {
    const result = TestEvent.safeParse({
      ...envelopeFields(),
      eventType: 'wrong.type',
      payload: { value: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an eventId that is not a UUID', () => {
    const result = TestEvent.safeParse({
      ...envelopeFields(),
      eventId: 'not-a-uuid',
      eventType: 'test.event',
      payload: { value: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload that violates the event-specific schema', () => {
    const result = TestEvent.safeParse({
      ...envelopeFields(),
      eventType: 'test.event',
      payload: { value: 'not-a-number' },
    });
    expect(result.success).toBe(false);
  });

  // What: a real catalogue event (transaction.received) validates end to end.
  // Why: proves defineEvent() composes correctly for an actual topic, not
  //      just the synthetic TestEvent above.
  it('validates a real transaction.received event', () => {
    const result = transactionReceivedEvent.safeParse({
      ...envelopeFields(),
      eventType: 'transaction.received',
      payload: {
        transactionId: 'txn_123',
        userId: 'user_123',
        merchantId: 'merchant_456',
        deviceId: 'device_789',
        amount: { minorUnits: 1999, currency: 'USD' },
        ipAddress: '203.0.113.7',
        timestamp: '2026-09-07T12:00:00Z',
      },
    });
    expect(result.success).toBe(true);
  });
});
