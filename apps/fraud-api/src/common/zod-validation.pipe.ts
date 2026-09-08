import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * FR-001's validation boundary: every request body is parsed through its
 * `packages/contracts` Zod schema before a handler ever sees it. A
 * validation failure becomes a 400 naming every offending field — the
 * `details` array is exactly what FR-001's acceptance criteria require,
 * and is what an invalid request produces with **zero** side effects,
 * since the handler never runs.
 */
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
