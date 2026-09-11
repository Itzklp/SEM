import type { FastifyInstance } from 'fastify';

import { registry } from './registry';

/**
 * Registers `GET <path>` directly on the supplied Fastify instance — same
 * "skip Nest's DI/module graph entirely" reasoning as `http-metrics.ts`:
 * this has to be reachable before/regardless of any auth guard, since
 * Prometheus itself (`infrastructure/monitoring/prometheus/prometheus.yml`)
 * is the caller, not an authenticated client. Deliberately unauthenticated
 * — scoped to local development and a Docker-internal network
 * (`docker-compose.yml`'s `fraudguard` network), never exposed publicly;
 * real deployments would put this behind network policy, not an API key,
 * which is Phase 11/out-of-scope hardening, not a Phase 7 concern.
 */
export function registerMetricsEndpoint(fastify: FastifyInstance, path: string): void {
  fastify.get(path, async (_request, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
}
