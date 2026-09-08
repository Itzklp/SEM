import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { load } from 'js-yaml';
import type { OpenAPIV3 } from 'openapi-types';
import type { Logger } from 'pino';

/**
 * Serves the hand-authored `docs/architecture/api/openapi.yaml` directly
 * as Swagger UI, rather than generating a spec from controller decorators.
 * Keeps exactly one source of truth for the API contract (Phase 1's design
 * document) instead of two that can drift — the DTOs it describes are Zod
 * schemas (packages/contracts), which NestJS's decorator-based Swagger
 * generation cannot introspect anyway.
 *
 * Best-effort: a missing spec file (e.g. a container image that didn't
 * copy /docs) logs a warning and skips Swagger UI rather than failing
 * startup — API documentation is not a hot-path dependency.
 */
export async function registerSwagger(app: NestFastifyApplication, logger: Logger): Promise<void> {
  const specPath = join(process.cwd(), '..', '..', 'docs', 'architecture', 'api', 'openapi.yaml');

  let document: OpenAPIV3.Document;
  try {
    document = load(readFileSync(specPath, 'utf-8')) as OpenAPIV3.Document;
  } catch (error) {
    logger.warn({ err: error, specPath }, 'OpenAPI spec not found — Swagger UI disabled');
    return;
  }

  const fastify = app.getHttpAdapter().getInstance();
  await fastify.register(fastifySwagger, { mode: 'static', specification: { document } });
  await fastify.register(fastifySwaggerUi, { routePrefix: '/api/v1/docs' });
}
