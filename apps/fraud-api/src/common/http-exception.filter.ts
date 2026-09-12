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

/** ADR-005's PostgreSQL fail-closed policy: the `Retry-After` value on every `503`. ASSUMED — short enough a client retrying in a loop doesn't wait long, long enough a container restart (Phase 2's measured ~10-20s) has a real chance of finishing first. Not yet tuned against a measured outage-duration distribution. */
const SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * Every error response — validation failure, auth failure, unhandled
 * exception — goes through here, so the wire shape (`errorResponseSchema`,
 * packages/contracts) is produced in exactly one place. An unhandled
 * (non-HttpException) error is logged with its real detail server-side but
 * returns a generic message to the client — NFR-008: internals are never
 * leaked, stack traces included.
 */
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

      // ADR-005: every 503 (today, only ScoringService.persistOrFailClosed's
      // PostgreSQL fail-closed path) tells the caller how long to wait
      // before retrying, via the standard header — not a body field, so
      // `errorResponseSchema`'s `.strict()` shape never needs to know about it.
      if (HttpStatus[status] === 'SERVICE_UNAVAILABLE') {
        void response.header('Retry-After', String(SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS));
      }

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

    // Unhandled — logged with full detail, never surfaced to the client.
    this.logger.error({ err: exception, requestId }, 'Unhandled exception');
    void response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId },
    });
  }
}
