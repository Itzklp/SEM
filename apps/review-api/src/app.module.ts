import { Module } from '@nestjs/common';

import { CasesModule } from './cases/cases.module';
import { CommonModule } from './common/common.module';
import { HealthModule } from './health/health.module';
import { TransactionsModule } from './transactions/transactions.module';

@Module({
  imports: [CommonModule, CasesModule, TransactionsModule, HealthModule],
})
export class AppModule {}
