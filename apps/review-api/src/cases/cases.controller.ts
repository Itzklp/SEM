import {
  paginationQuerySchema,
  reviewCaseRequestSchema,
  type FraudCaseDto,
  type ReviewCaseRequest,
} from '@fraudguard/contracts';
import { CASE_STATUSES } from '@fraudguard/domain';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePrivileges } from '../auth/privileges.decorator';
import { PrivilegesGuard } from '../auth/privileges.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

import { toFraudCaseDto } from './case.mapper';
import { CasesService } from './cases.service';

/** Query params for `GET /fraud/cases` — `paginationQuerySchema` plus the status filter, defaulting to the review queue's own default (FR-010: "defaults to open cases"). */
const listCasesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(CASE_STATUSES).default('OPEN'),
});

/** FR-010, FR-011. Cold path — none of ADR-003's latency budget applies here (an analyst waiting on a page load, not a payment authorization). */
@Controller('api/v1/fraud/cases')
@UseGuards(JwtAuthGuard, PrivilegesGuard)
export class CasesController {
  constructor(private readonly casesService: CasesService) {}

  @Get()
  @RequirePrivileges('review')
  async list(
    @Query(new ZodValidationPipe(listCasesQuerySchema)) query: z.infer<typeof listCasesQuerySchema>,
  ): Promise<{ items: FraudCaseDto[]; page: number; pageSize: number; totalItems: number }> {
    const result = await this.casesService.list(query.status, query.page, query.pageSize);
    return {
      items: result.items.map(toFraudCaseDto),
      page: result.page,
      pageSize: result.pageSize,
      totalItems: result.totalItems,
    };
  }

  @Get(':id')
  @RequirePrivileges('review')
  async getOne(@Param('id') id: string): Promise<FraudCaseDto> {
    const fraudCase = await this.casesService.getById(id);
    return toFraudCaseDto(fraudCase);
  }

  /** `reviewerId` comes from the authenticated caller (`request.auth`), never from the request body (ASM-006) — a caller cannot attribute their review action to someone else. `@HttpCode(200)`: this transitions an EXISTING case, per openapi.yaml's documented response — NestJS's bare `@Post()` default (201 Created) is wrong for an action that never creates a new resource. Caught live, not by reading the spec twice. */
  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @RequirePrivileges('review')
  async review(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reviewCaseRequestSchema)) body: ReviewCaseRequest,
    @Req() request: FastifyRequest,
  ): Promise<FraudCaseDto> {
    // JwtAuthGuard (registered above via @UseGuards) always populates this before a handler runs.
    const reviewerId = request.auth?.clientId ?? '';
    const updated = await this.casesService.review(id, body.action, reviewerId, body.reason);
    return toFraudCaseDto(updated);
  }
}
