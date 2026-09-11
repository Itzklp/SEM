import { execSync } from 'node:child_process';
import { join } from 'node:path';

import { loadConfig } from '@fraudguard/config';
import { scoreResponseSchema, type ScoreRequest } from '@fraudguard/contracts';
import { createKafkaClient, createProducer } from '@fraudguard/messaging';
import {
  closePersistenceContext,
  OutboxRepository,
  type PersistenceContext,
} from '@fraudguard/persistence';
import { signTestToken } from '@fraudguard/testkit';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import pino from 'pino';

import { runOutboxRelayOnce } from '../../apps/event-worker/src/relay/outbox-relay';
import { AppModule } from '../../apps/fraud-api/src/app.module';
import { HttpExceptionFilter } from '../../apps/fraud-api/src/common/http-exception.filter';
import { PERSISTENCE_CONTEXT } from '../../apps/fraud-api/src/common/persistence.provider';
import { REDIS_CLIENT } from '../../apps/fraud-api/src/common/redis.provider';

const REPO_ROOT = join(__dirname, '..', '..');
// execSync has no timeout by default — an unresponsive docker daemon
// would then block this ENTIRE process indefinitely, including Jest's
// own per-test timeout (which relies on the event loop, and a
// synchronous call blocks it). A bounded timeout here is what makes
// "this test took too long" fail loudly instead of hanging the suite.
const DOCKER_COMMAND_TIMEOUT_MS = 30_000;

function dockerCompose(args: string): void {
  execSync(`docker compose ${args}`, {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    timeout: DOCKER_COMMAND_TIMEOUT_MS,
  });
}

function isKafkaHealthy(): boolean {
  try {
    const output = execSync('docker compose ps kafka --format "{{.Status}}"', {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      timeout: DOCKER_COMMAND_TIMEOUT_MS,
    }).toString();
    return output.includes('healthy');
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return predicate();
}

/**
 * Phase 6 exit criterion, verbatim (docs/ROADMAP.md): "Kafka stopped for
 * the duration of a load run: authorizations unaffected, outbox drains
 * fully on recovery." Genuinely stops the real `kafka` container — not a
 * mock, not a simulated error — because ADR-001's entire claim is that
 * this system's hot path has no dependency on Kafka being reachable at
 * all, and the only way to actually prove that is to make it
 * unreachable.
 *
 * Slow by nature (a real container stop/start, and Kafka's own cold
 * start is the slowest thing in this stack per docker-compose.yml) — a
 * generous Jest timeout, not a tight one, is the honest choice here.
 *
 * Caught live: the test itself consistently passed in under a minute,
 * but the process then sat well past Jest's own "did not exit" warning
 * — a kafkajs internal handle (most likely a reconnect/retry timer
 * surviving the broker's stop/start cycle) outlived `producer
 * .disconnect()`. Not worth chasing into kafkajs's internals for one
 * test file; `pnpm test:resilience` runs with `--forceExit` (package
 * .json) specifically because an external-process resilience test
 * touching a real container is exactly the case that flag exists for —
 * documented here, not hidden, since `--forceExit` silently papering
 * over an ACTUAL test-code leak elsewhere would be the wrong kind of fix.
 */
describe('resilience: Kafka outage does not affect fraud-api authorizations', () => {
  let app: NestFastifyApplication;
  let persistence: PersistenceContext;
  let redis: Redis;
  let scoreToken: string;

  beforeAll(async () => {
    // Guarantee a known starting state — a prior failed run of this
    // exact test could otherwise leave Kafka stopped, which would make
    // EVERY other integration test in the same CI run fail for a reason
    // that has nothing to do with what they're testing.
    if (!isKafkaHealthy()) {
      dockerCompose('start kafka');
      await waitUntil(isKafkaHealthy, 90_000);
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new HttpExceptionFilter(pino({ level: 'silent' })));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    persistence = app.get<PersistenceContext>(PERSISTENCE_CONTEXT);
    redis = app.get<Redis>(REDIS_CLIENT);
    if (redis.status !== 'ready') {
      await new Promise((resolve) => redis.once('ready', resolve));
    }

    const config = loadConfig();
    scoreToken = signTestToken({
      secret: config.security.jwt.secret,
      issuer: config.security.jwt.issuer,
      audience: config.security.jwt.audience,
      privileges: ['score'],
    });

    // The idempotency cache (FR-017), not just Postgres — missed on the
    // first pass here. Caught live: a second run of this exact test
    // hit the Redis fast path and returned the FIRST run's cached
    // response without touching Postgres at all, so the outbox-row
    // assertion found zero rows instead of the two it expected. Same
    // bug class as demo-scenarios/policy-admin's identical fix, missed
    // here because this file was written after those, not copied from them.
    await redis.del('idem:kafka_outage_demo');
    await persistence.hotPool.query('DELETE FROM outbox_events WHERE aggregate_id = $1', [
      'kafka_outage_demo',
    ]);
    await persistence.hotPool.query('DELETE FROM decisions WHERE transaction_id = $1', [
      'kafka_outage_demo',
    ]);
    await persistence.hotPool.query('DELETE FROM transactions WHERE transaction_id = $1', [
      'kafka_outage_demo',
    ]);
  }, 120_000);

  afterAll(async () => {
    // Restored in beforeAll already if the test body itself failed
    // before reaching its own restart step — this is the final backstop
    // so a failure here never leaves Kafka down for whatever runs next.
    if (!isKafkaHealthy()) {
      dockerCompose('start kafka');
      await waitUntil(isKafkaHealthy, 90_000);
    }
    await redis.quit();
    await closePersistenceContext(persistence);
    await app.close();
  }, 120_000);

  function inject(payload: unknown) {
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/fraud/score',
        headers: { authorization: `Bearer ${scoreToken}` },
        payload,
      });
  }

  function buildRequest(): ScoreRequest {
    return {
      transactionId: 'kafka_outage_demo',
      userId: 'kafka_outage_user',
      merchantId: 'kafka_outage_merchant',
      deviceId: 'kafka_outage_device',
      amount: { minorUnits: 1_500, currency: 'USD' },
      ipAddress: '203.0.113.1',
      paymentMethod: 'card_token_demo',
      timestamp: new Date().toISOString(),
    };
  }

  it('authorizes normally while Kafka is down, and the outbox drains fully once it recovers', async () => {
    dockerCompose('stop kafka');

    try {
      // --- Kafka is down. The hot path must not notice. -------------------
      const request = buildRequest();
      const response = await inject(request);
      expect(response.statusCode).toBe(200);
      const parsed = scoreResponseSchema.safeParse(response.json());
      expect(parsed.success).toBe(true);

      // The decision IS durably recorded — ADR-006's whole point — even
      // though nothing has been published anywhere yet.
      const rows = await persistence.hotPool.query<{ published_at: string | null }>(
        'SELECT published_at FROM outbox_events WHERE aggregate_id = $1',
        [request.transactionId],
      );
      expect(rows.rows.length).toBe(2); // transaction.received + transaction.decided
      expect(rows.rows.every((r) => r.published_at === null)).toBe(true);
    } finally {
      // --- Recovery. --------------------------------------------------
      dockerCompose('start kafka');
    }

    const recovered = await waitUntil(isKafkaHealthy, 90_000);
    expect(recovered).toBe(true);

    const config = loadConfig();
    const kafka = createKafkaClient(config);
    const producer = createProducer(kafka);
    await producer.connect();
    const outboxRepository = new OutboxRepository(persistence.coldDb);
    const logger = pino({ level: 'silent' });

    // The broker reporting "healthy" (its own container healthcheck)
    // and actually being ready to accept a produce from this process
    // through the PLAINTEXT_HOST listener are not the same instant —
    // retry briefly rather than asserting success on the first attempt.
    let drained = false;
    for (let attempt = 0; attempt < 10 && !drained; attempt += 1) {
      try {
        const result = await runOutboxRelayOnce({
          outboxRepository,
          producer,
          logger,
          batchSize: 50,
        });
        if (result.publishedCount >= 2 && result.failedCount === 0) {
          drained = true;
        }
      } catch {
        // not ready yet — retried below
      }
      if (!drained) {
        await sleep(2_000);
      }
    }
    await producer.disconnect();

    expect(drained).toBe(true);
    const finalRows = await persistence.hotPool.query<{ published_at: string | null }>(
      'SELECT published_at FROM outbox_events WHERE aggregate_id = $1',
      ['kafka_outage_demo'],
    );
    expect(finalRows.rows.every((r) => r.published_at !== null)).toBe(true);
  }, 150_000);
});
