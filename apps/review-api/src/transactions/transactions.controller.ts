import type { TransactionDetail } from '@fraudguard/contracts';
import { Controller, Get, Param, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePrivileges } from '../auth/privileges.decorator';
import { PrivilegesGuard } from '../auth/privileges.guard';

import { toTransactionDetailDto } from './transaction.mapper';
import { TransactionsService } from './transactions.service';

/** FR-008, FR-014. Cold path — query-only, no latency budget (ADR-003 does not apply here). */
@Controller('api/v1/transactions')
@UseGuards(JwtAuthGuard, PrivilegesGuard)
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get(':id')
  @RequirePrivileges('review')
  async getOne(@Param('id') id: string): Promise<TransactionDetail> {
    const result = await this.transactionsService.getById(id);
    return toTransactionDetailDto(result);
  }
}
