import { scoreRequestSchema, type ScoreRequest, type ScoreResponse } from '@fraudguard/contracts';
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePrivileges } from '../auth/privileges.decorator';
import { PrivilegesGuard } from '../auth/privileges.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

import { ScoringService } from './scoring.service';

/** FR-001, FR-006. The single hot-path endpoint — everything downstream of `@Body()` is on the ADR-003 latency budget. */
@Controller('api/v1/fraud')
@UseGuards(JwtAuthGuard, PrivilegesGuard)
export class ScoringController {
  constructor(private readonly scoringService: ScoringService) {}

  @Post('score')
  @HttpCode(HttpStatus.OK)
  @RequirePrivileges('score')
  async score(
    @Body(new ZodValidationPipe(scoreRequestSchema)) request: ScoreRequest,
  ): Promise<ScoreResponse> {
    return this.scoringService.score(request);
  }
}
