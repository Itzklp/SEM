import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Identical to fraud-api's — see jwt-auth.guard.ts's doc comment on why this is duplicated, not shared. */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
      }));
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Request failed validation',
        details,
      });
    }
    return result.data;
  }
}
