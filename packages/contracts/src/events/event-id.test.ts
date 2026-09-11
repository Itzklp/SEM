import { z } from 'zod';

import { deterministicEventId } from './event-id';

describe('deterministicEventId', () => {
  it('is deterministic for the same (aggregateId, eventType) pair', () => {
    const a = deterministicEventId('txn_1', 'transaction.decided');
    const b = deterministicEventId('txn_1', 'transaction.decided');
    expect(a).toBe(b);
  });

  it('differs for a different aggregateId', () => {
    expect(deterministicEventId('txn_1', 'transaction.decided')).not.toBe(
      deterministicEventId('txn_2', 'transaction.decided'),
    );
  });

  it('differs for a different eventType on the same aggregate', () => {
    expect(deterministicEventId('txn_1', 'transaction.received')).not.toBe(
      deterministicEventId('txn_1', 'transaction.decided'),
    );
  });

  it('produces a well-formed UUID (version 5, correct variant)', () => {
    const id = deterministicEventId('txn_1', 'transaction.decided');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('validates against the real z.string().uuid() check eventEnvelopeSchema uses', () => {
    const id = deterministicEventId('txn_1', 'transaction.decided');
    expect(z.string().uuid().safeParse(id).success).toBe(true);
  });
});
