import { Module } from '@nestjs/common';

import { CommonModule } from './common/common.module';
import { HealthModule } from './health/health.module';
import { ScoringModule } from './scoring/scoring.module';

@Module({
  imports: [CommonModule, ScoringModule, HealthModule],
})
export class AppModule {}
