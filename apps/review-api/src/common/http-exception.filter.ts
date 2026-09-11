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

/** Identical to fraud-api's — see jwt-auth.guard.ts's doc comment on why this is duplicated, not shared. Produces the same `errorResponseSchema` wire shape from every error. */
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

    this.logger.error({ err: exception, requestId }, 'Unhandled exception');
    void response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId },
    });
  }
}
