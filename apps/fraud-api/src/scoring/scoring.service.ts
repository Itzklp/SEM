import type { AppConfig } from '@fraudguard/config';
import type { ScoreRequest, ScoreResponse } from '@fraudguard/contracts';
import {
  createTransaction,
  decide,
  buildReasons,
  Money,
  transitionTransaction,
  type FraudDecision,
  type FraudScoringProvider,
  type DegradedReason,
  type FeatureVector,
  type Transaction,
} from '@fraudguard/domain';
import {
  getFeatureVector,
  getIdempotentResult,
  storeIdempotentResult,
} from '@fraudguard/feature-store';
import {
  fraudDecisionsTotal,
  fraudScoreDurationSeconds,
  measure,
  transactionsTotal,
} from '@fraudguard/observability';
import type { DecisionRow, TransactionRepository } from '@fraudguard/persistence';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { APP_CONFIG } from '../common/config.provider';
import { LOGGER } from '../common/logger.provider';
import { TRANSACTION_REPOSITORY } from '../common/persistence.provider';
import { POLICY_STORE, type PolicyStore } from '../common/policy-store';
import { REDIS_CLIENT } from '../common/redis.provider';

import { buildOutboxEvents } from './build-outbox-events';
import { createScoringProvider } from './scoring-provider.factory';

/**
 * FR-017: how long a duplicate `transactionId` still returns the original
 * decision via the Redis fast path. Chosen generously (24h) against
 * Redis's `maxmemory 200mb` (ADR-002) — a realistic retry/replay window
 * without growing the keyspace unboundedly; revisit with measurement if
 * Phase 9 load testing shows keyspace pressure.
 */
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * Orchestrates the full hot-path pipeline (ARCHITECTURE.md §7): idempotency
 * → feature load → score → decide → persist → respond. This is where the
 * transaction lifecycle state machine (packages/domain) is actually driven
 * — every transition is asserted, so an ordering bug here throws
 * immediately rather than silently producing an inconsistent transaction.
 */
@Injectable()
export class ScoringService {
  private readonly scoringProvider: FraudScoringProvider;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(TRANSACTION_REPOSITORY) private readonly transactionRepository: TransactionRepository,
    @Inject(POLICY_STORE) private readonly policyStore: PolicyStore,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.scoringProvider = createScoringProvider(config);
  }

  async score(request: ScoreRequest): Promise<ScoreResponse> {
    const startedAt = Date.now();

    // --- Idempotency fast path (FR-017) ------------------------------------
    const cached = await measure(
      {
        span: 'score.idempotency_check',
        histogram: fraudScoreDurationSeconds,
        labels: { stage: 'idempotency_check' },
      },
      () => this.tryGetIdempotentResult(request.transactionId),
    );
    if (cached) {
      transactionsTotal.inc({ replay: 'true' });
      this.logger.info(
        { transactionId: request.transactionId },
        'Duplicate transaction — returning cached decision',
      );
      return cached;
    }
    transactionsTotal.inc({ replay: 'false' });

    // --- RECEIVED -> VALIDATED (Zod already validated the wire shape; this
    // constructs the domain Transaction, which re-checks domain invariants) --
    const transaction = createTransaction({
      transactionId: request.transactionId,
      userId: request.userId,
      merchantId: request.merchantId,
      deviceId: request.deviceId,
      amount: Money.of(request.amount.minorUnits, request.amount.currency),
      ipAddress: request.ipAddress,
      paymentMethod: request.paymentMethod,
      timestamp: new Date(request.timestamp),
    });
    // transitionTransaction() both validates the edge is legal (throws if
    // not) AND returns the new status — the return value has to be
    // captured and carried forward, or the persisted transaction stays
    // stuck at its original status forever. (Caught live: every row in
    // `transactions` had status='RECEIVED' regardless of how far the
    // pipeline actually got, because this assignment was originally missing.)
    let status = transitionTransaction(transaction.status, 'VALIDATED');

    // --- VALIDATED -> FEATURES_LOADED ---------------------------------------
    // Real behavioural features (Phase 4, FR-002, ADR-002). The write side
    // (`recordTransactionFeatures`) deliberately does NOT run here — per
    // ARCHITECTURE.md's service-responsibility table, feature *writes* are
    // the cold path's job (Phase 6's event-worker, consuming
    // `transaction.decided`), so that a slow aggregation write can never
    // slow an authorization. Only the read happens on the hot path.
    const features = await measure(
      {
        span: 'score.feature_fetch',
        histogram: fraudScoreDurationSeconds,
        labels: { stage: 'feature_fetch' },
      },
      () => this.tryGetFeatureVector(transaction),
    );
    status = transitionTransaction(status, 'FEATURES_LOADED');
    const degraded = features.source !== 'live';
    const degradedReason: DegradedReason = degraded ? 'FEATURES_UNAVAILABLE' : 'NONE';

    // --- FEATURES_LOADED -> SCORED ------------------------------------------
    const scoringResult = await measure(
      { span: 'score.score', histogram: fraudScoreDurationSeconds, labels: { stage: 'score' } },
      () => this.scoringProvider.score({ transaction, features }),
    );
    status = transitionTransaction(status, 'SCORED');

    // --- SCORED -> DECIDED ---------------------------------------------------
    // Read fresh on every request, not cached — FR-006: a policy change
    // via the admin endpoint (admin/policy.controller.ts) takes effect on
    // the very next request, with no restart (PolicyStore's doc comment).
    const policy = this.policyStore.get();
    // `decide()`/`buildReasons()` are synchronous and in-memory — no
    // `await` inside, so this is `() => Promise.resolve(...)` rather than
    // an `async` arrow (`@typescript-eslint/require-await`). Still timed
    // via `measure()` like every other stage: cheap today is not a
    // guarantee it stays cheap, and ADR-003 asks for every stage's timing.
    const { decision, reasons } = await measure(
      { span: 'score.decide', histogram: fraudScoreDurationSeconds, labels: { stage: 'decide' } },
      () => {
        const decidedValue = decide(scoringResult.score, policy, degraded);
        // FR-007's floor: every non-ALLOW decision carries at least one
        // reason, even if zero rules triggered (the model or behavioural
        // signal alone can push the score past a threshold) — enforced
        // once, here, rather than trusted to every provider individually.
        return Promise.resolve({
          decision: decidedValue,
          reasons: buildReasons(scoringResult.riskFactors, decidedValue),
        });
      },
    );
    status = transitionTransaction(status, 'DECIDED');
    const decidedTransaction: Transaction = { ...transaction, status };

    const processingTimeMs = Date.now() - startedAt;
    const fraudDecision: FraudDecision = {
      transactionId: transaction.transactionId,
      decision,
      riskScore: scoringResult.score,
      reasons,
      policyVersion: policy.policyVersion,
      modelVersion: scoringResult.modelVersion,
      scoringProvider: scoringResult.provider,
      degraded,
      degradedReason,
      decidedAt: new Date(),
      processingTimeMs,
    };
    fraudDecisionsTotal.inc({ decision, degraded: String(degraded) });

    // --- Persist (ADR-006: decision write, one transaction) -----------------
    // The outbox rows are written atomically with the decision itself —
    // either the decision, both domain rows AND the outbox rows all
    // exist, or none of them do. apps/event-worker's relay (Phase 6)
    // picks these up after the response has already been returned;
    // nothing here talks to Kafka (ADR-001 — enforced by the hot-path
    // architecture test's import scan).
    const outboxEventInputs = buildOutboxEvents(decidedTransaction, fraudDecision);
    const persisted = await measure(
      { span: 'score.persist', histogram: fraudScoreDurationSeconds, labels: { stage: 'persist' } },
      () =>
        this.transactionRepository.insertScored(
          decidedTransaction,
          fraudDecision,
          outboxEventInputs,
        ),
    );
    if (persisted.wasExisting) {
      // Redis missed it (down, or a race), but the database's unique
      // constraint caught the duplicate — FR-017 still holds via the
      // backstop described in TransactionRepository.
      this.logger.warn(
        { transactionId: request.transactionId },
        'Idempotency backstop: DB-level duplicate caught after Redis fast path missed it',
      );
      const response = this.toResponse(persisted.decision, 0);
      await this.tryStoreIdempotentResult(request.transactionId, response);
      return response;
    }

    const response = this.toResponse(persisted.decision, processingTimeMs);
    await this.tryStoreIdempotentResult(request.transactionId, response);
    return response;
  }

  private toResponse(decisionRow: DecisionRow, processingTimeMs: number): ScoreResponse {
    return {
      transactionId: decisionRow.transactionId,
      decision: decisionRow.decision as ScoreResponse['decision'],
      // numeric() round-trips through drizzle as a string — see schema.ts.
      riskScore: Number(decisionRow.riskScore),
      reasons: decisionRow.reasons,
      policyVersion: decisionRow.policyVersion,
      modelVersion: decisionRow.modelVersion,
      scoringProvider: decisionRow.scoringProvider as ScoreResponse['scoringProvider'],
      degraded: decisionRow.degraded,
      degradedReason: decisionRow.degradedReason as ScoreResponse['degradedReason'],
      processingTimeMs,
    };
  }

  /** ADR-005's Redis cautious-open fallback, made explicitly here (not inside `@fraudguard/feature-store`, which throws on failure by design — see `getFeatureVector`'s doc comment). A degraded vector is indistinguishable, to every downstream consumer, from Phase 3's "no real features yet" placeholder — same shape, same handling, different cause. */
  private async tryGetFeatureVector(transaction: Transaction): Promise<FeatureVector> {
    try {
      return await getFeatureVector(this.redis, {
        userId: transaction.userId,
        deviceId: transaction.deviceId,
        merchantId: transaction.merchantId,
        ipAddress: transaction.ipAddress,
      });
    } catch (error) {
      this.logger.warn(
        { err: error, transactionId: transaction.transactionId },
        'Feature fetch failed (Redis unavailable) — proceeding cautious-open with declared defaults',
      );
      return {
        userId: transaction.userId,
        computedAt: new Date(),
        source: 'unavailable',
        features: {},
      };
    }
  }

  /** ADR-005: a Redis failure here means "unknown", not "not a duplicate" — falls through to the DB backstop rather than crashing the request. */
  private async tryGetIdempotentResult(transactionId: string): Promise<ScoreResponse | null> {
    try {
      return await getIdempotentResult<ScoreResponse>(this.redis, transactionId);
    } catch (error) {
      this.logger.warn(
        { err: error, transactionId },
        'Idempotency check failed (Redis unavailable) — proceeding, DB backstop applies',
      );
      return null;
    }
  }

  /** Best-effort: a failure to cache the result does not fail the request — the decision is already durably persisted. */
  private async tryStoreIdempotentResult(
    transactionId: string,
    response: ScoreResponse,
  ): Promise<void> {
    try {
      await storeIdempotentResult(this.redis, transactionId, response, IDEMPOTENCY_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, transactionId },
        'Failed to cache idempotency result (Redis unavailable)',
      );
    }
  }
}
