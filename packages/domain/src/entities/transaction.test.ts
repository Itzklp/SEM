import { InvariantViolationError } from '../errors';
import { Money } from '../value-objects/money';

import { createTransaction } from './transaction';

function validInput() {
  return {
    transactionId: 'txn_123',
    userId: 'user_123',
    merchantId: 'merchant_456',
    deviceId: 'device_789',
    amount: Money.of(1999, 'USD'),
    ipAddress: '203.0.113.7',
    paymentMethod: 'card_token_abc',
    timestamp: new Date('2026-09-07T12:00:00Z'),
  };
}

describe('createTransaction', () => {
  // What: a well-formed request produces a RECEIVED transaction.
  // Why: FR-001's happy path — this is the entry point to the whole system.
  it('creates a transaction in RECEIVED status', () => {
    const txn = createTransaction(validInput());
    expect(txn.status).toBe('RECEIVED');
    expect(txn.transactionId).toBe('txn_123');
  });

  // What: identifier fields are validated against a safe character set.
  // Why: FR-001 requires malformed input to be rejected with no partial
  //      side effects. Identifiers flow into Redis keys, SQL parameters and
  //      Kafka partition keys downstream — rejecting an unsafe identifier
  //      here, once, is cheaper than defending every downstream consumer.
  // Catches: an empty id, or one containing characters that could act as a
  //          key-injection vector in a downstream store.
  it.each(['transactionId', 'userId', 'merchantId', 'deviceId'] as const)(
    'rejects an empty %s',
    (field) => {
      const input = { ...validInput(), [field]: '' };
      expect(() => createTransaction(input)).toThrow(InvariantViolationError);
    },
  );

  it('rejects an id containing unsafe characters', () => {
    const input = { ...validInput(), userId: 'user; DROP TABLE transactions;' };
    expect(() => createTransaction(input)).toThrow(InvariantViolationError);
  });

  it('rejects an invalid timestamp', () => {
    const input = { ...validInput(), timestamp: new Date('not-a-date') };
    expect(() => createTransaction(input)).toThrow(InvariantViolationError);
  });
});
