import type { DecisionRow, TransactionRepository, TransactionRow } from '@fraudguard/persistence';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { TRANSACTION_REPOSITORY } from '../common/persistence.provider';

@Injectable()
export class TransactionsService {
  constructor(
    @Inject(TRANSACTION_REPOSITORY) private readonly transactionRepository: TransactionRepository,
  ) {}

  async getById(
    transactionId: string,
  ): Promise<{ transaction: TransactionRow; decision: DecisionRow }> {
    const result = await this.transactionRepository.findByTransactionId(transactionId);
    if (!result) {
      throw new NotFoundException({
        code: 'TRANSACTION_NOT_FOUND',
        message: `No transaction with id ${transactionId}`,
      });
    }
    return result;
  }
}
