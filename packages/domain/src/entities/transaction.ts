import type { TransactionStatus } from '../enums';
import { InvariantViolationError } from '../errors';
import type { Money } from '../value-objects/money';

/**
 * A payment authorization request, as understood by the domain — the wire
 * shape (packages/contracts) is a separate, stricter-validated concern that
 * maps onto this. FR-001, entity list in Brief §9.
 */
export interface Transaction {
  readonly transactionId: string;
  readonly userId: string;
  readonly merchantId: string;
  readonly deviceId: string;
  readonly amount: Money;
  readonly ipAddress: string;
  readonly paymentMethod: string;
  readonly timestamp: Date;
  readonly status: TransactionStatus;
}

export interface CreateTransactionInput {
  transactionId: string;
  userId: string;
  merchantId: string;
  deviceId: string;
  amount: Money;
  ipAddress: string;
  paymentMethod: string;
  timestamp: Date;
}

const NON_EMPTY_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * The only way to obtain a `Transaction` outside a lifecycle transition.
 * Enforces the invariants that must hold before a transaction can enter
 * `RECEIVED` — anything failing here is a `REJECTED` transaction at the API
 * boundary, never a half-constructed domain object.
 */
export function createTransaction(input: CreateTransactionInput): Transaction {
  for (const field of ['transactionId', 'userId', 'merchantId', 'deviceId'] as const) {
    if (!NON_EMPTY_ID.test(input[field])) {
      throw new InvariantViolationError(
        field,
        `${field} must be a non-empty identifier of up to 128 characters`,
      );
    }
  }
  if (Number.isNaN(input.timestamp.getTime())) {
    throw new InvariantViolationError('timestamp', 'timestamp must be a valid date');
  }

  return {
    transactionId: input.transactionId,
    userId: input.userId,
    merchantId: input.merchantId,
    deviceId: input.deviceId,
    amount: input.amount,
    ipAddress: input.ipAddress,
    paymentMethod: input.paymentMethod,
    timestamp: input.timestamp,
    status: 'RECEIVED',
  };
}
