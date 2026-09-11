import {
  policyUpdateRequestSchema,
  type PolicyResponse,
  type PolicyUpdateRequest,
} from '@fraudguard/contracts';
import { InvalidPolicyError } from '@fraudguard/domain';
import { BadRequestException, Body, Controller, Get, Inject, Put, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePrivileges } from '../auth/privileges.decorator';
import { PrivilegesGuard } from '../auth/privileges.guard';
import { POLICY_STORE, type PolicyStore } from '../common/policy-store';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/**
 * FR-006's runtime-configurability requirement, as an actual endpoint —
 * cold path (an operator action, not a payment authorization), so none
 * of ADR-003's latency budget applies here. `'admin'` is a privilege
 * distinct from `'score'`/`'review'` (FR-015, `privileges.decorator.ts`'s
 * own doc comment already names it) — a scoring client token cannot
 * reach this endpoint.
 */
@Controller('api/v1/admin/policy')
@UseGuards(JwtAuthGuard, PrivilegesGuard)
export class PolicyController {
  constructor(@Inject(POLICY_STORE) private readonly policyStore: PolicyStore) {}

  @Get()
  @RequirePrivileges('admin')
  get(): PolicyResponse {
    return this.policyStore.get();
  }

  @Put()
  @RequirePrivileges('admin')
  update(
    @Body(new ZodValidationPipe(policyUpdateRequestSchema)) request: PolicyUpdateRequest,
  ): PolicyResponse {
    try {
      this.policyStore.set(request);
    } catch (error) {
      if (error instanceof InvalidPolicyError) {
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      throw error;
    }
    return this.policyStore.get();
  }
}
