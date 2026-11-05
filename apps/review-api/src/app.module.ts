import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module';
import { CasesModule } from './cases/cases.module';
import { CommonModule } from './common/common.module';
import { HealthModule } from './health/health.module';
import { ModelsModule } from './models/models.module';
import { SystemOpsModule } from './system-ops/system-ops.module';
import { TransactionsModule } from './transactions/transactions.module';

@Module({
  imports: [
    CommonModule,
    CasesModule,
    TransactionsModule,
    ModelsModule,
    HealthModule,
    AuthModule,
    SystemOpsModule,
  ],
})
export class AppModule {}
