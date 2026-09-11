import { createServer, type Server } from 'node:http';

import { registry } from '@fraudguard/observability';

/**
 * `event-worker` has no HTTP framework at all (`main.ts`'s doc comment:
 * deliberately no NestJS/Fastify — a background poller/consumer has no
 * HTTP surface to serve). `packages/observability`'s
 * `registerMetricsEndpoint` is Fastify-specific (`http-metrics.ts`/
 * `metrics-route.ts` both take a `FastifyInstance`) — rather than make
 * that package support two web frameworks for one route, this is a
 * three-line plain `node:http` server, matching the minimalism of this
 * app's existing design choice.
 */
export function startMetricsServer(port: number): Server {
  const server = createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'Content-Type': registry.contentType }).end(body);
      })
      .catch((error: unknown) => {
        res.writeHead(500).end(error instanceof Error ? error.message : String(error));
      });
  });
  server.listen(port, '0.0.0.0');
  return server;
}
