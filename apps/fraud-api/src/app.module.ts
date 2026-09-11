import { Module } from '@nestjs/common';

import { AdminModule } from './admin/admin.module';
import { CommonModule } from './common/common.module';
import { HealthModule } from './health/health.module';
import { ScoringModule } from './scoring/scoring.module';

@Module({
  imports: [CommonModule, ScoringModule, HealthModule, AdminModule],
})
export class AppModule {}
