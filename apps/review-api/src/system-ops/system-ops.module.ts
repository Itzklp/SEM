import { Module } from '@nestjs/common';

import { SystemHealthController } from './system-health.controller';
import { TestRunExecutorService } from './test-run-executor.service';
import { TestRunsController } from './test-runs.controller';

@Module({
  controllers: [SystemHealthController, TestRunsController],
  providers: [TestRunExecutorService],
})
export class SystemOpsModule {}
