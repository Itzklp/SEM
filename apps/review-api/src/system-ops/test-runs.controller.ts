import {
  startTestRunRequestSchema,
  type StartTestRunRequest,
  type TestRunDetailDto,
  type TestRunSummaryDto,
} from '@fraudguard/contracts';
import type { TestRunRepository } from '@fraudguard/persistence';
import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePrivileges } from '../auth/privileges.decorator';
import { PrivilegesGuard } from '../auth/privileges.guard';
import { TEST_RUN_REPOSITORY } from '../common/persistence.provider';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

import { TestRunExecutorService } from './test-run-executor.service';

const RECENT_RUNS_LIMIT = 20;

@Controller('api/v1/admin/test-runs')
@UseGuards(JwtAuthGuard, PrivilegesGuard)
@RequirePrivileges('admin')
export class TestRunsController {
  constructor(
    private readonly executor: TestRunExecutorService,
    @Inject(TEST_RUN_REPOSITORY) private readonly runs: TestRunRepository,
  ) {}

  @Post()
  @UsePipes(new ZodValidationPipe(startTestRunRequestSchema))
  async start(
    @Body() body: StartTestRunRequest,
    @Req() request: FastifyRequest,
  ): Promise<{ id: string }> {
    const triggeredBy = request.auth?.clientId ?? 'unknown';
    const id = await this.executor.start(body.suite, triggeredBy);
    return { id };
  }

  @Get()
  async list(): Promise<TestRunSummaryDto[]> {
    const rows = await this.runs.listRecent(RECENT_RUNS_LIMIT);
    return rows.map((row) => ({
      id: row.id,
      suite: row.suite,
      status: row.status,
      triggeredBy: row.triggeredBy,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      passedCount: row.passedCount,
      failedCount: row.failedCount,
      totalCount: row.totalCount,
    }));
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<TestRunDetailDto> {
    const row = await this.runs.findById(id);
    if (!row) {
      throw new NotFoundException({
        code: 'TEST_RUN_NOT_FOUND',
        message: 'No test run with that id',
      });
    }
    return {
      id: row.id,
      suite: row.suite,
      status: row.status,
      triggeredBy: row.triggeredBy,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      passedCount: row.passedCount,
      failedCount: row.failedCount,
      totalCount: row.totalCount,
      log: row.log,
    };
  }
}
