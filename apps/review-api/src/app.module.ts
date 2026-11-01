import { Module } from '@nestjs/common';

import { CasesModule } from './cases/cases.module';
import { CommonModule } from './common/common.module';
import { HealthModule } from './health/health.module';
import { ModelsModule } from './models/models.module';
import { TransactionsModule } from './transactions/transactions.module';

@Module({
  imports: [CommonModule, CasesModule, TransactionsModule, ModelsModule, HealthModule],
})
export class AppModule {}
