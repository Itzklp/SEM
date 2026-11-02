import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

interface ErrorBody {
  code?: string;
  message?: string;
  details?: { field: string; message: string }[];
}

/** Mirrors fraud-api's filter (duplicated rather than shared, see jwt-auth.guard.ts) — same errorResponseSchema wire shape from every error. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const requestId = request.id;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const errorBody: ErrorBody = typeof body === 'string' ? { message: body } : body;

      void response.status(status).send({
        error: {
          code: errorBody.code ?? HttpStatus[status] ?? 'ERROR',
          message: errorBody.message ?? exception.message,
          ...(errorBody.details ? { details: errorBody.details } : {}),
          requestId,
        },
      });
      return;
    }

    // Kept in sync with fraud-api's copy: any Fastify-level error with a
    // numeric .statusCode gets its real status, not a silent 500.
    if (
      exception instanceof Error &&
      'statusCode' in exception &&
      typeof exception.statusCode === 'number' &&
      exception.statusCode >= 400 &&
      exception.statusCode < 600
    ) {
      const status = exception.statusCode;
      void response.status(status).send({
        error: { code: HttpStatus[status] ?? 'ERROR', message: exception.message, requestId },
      });
      return;
    }

    this.logger.error({ err: exception, requestId }, 'Unhandled exception');
    void response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId },
    });
  }
}
