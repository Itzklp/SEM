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
import {
  isPgConnectivityError,
  type DecisionRow,
  type OutboxEventInput,
  type ScoredTransactionResult,
  type TransactionRepository,
} from '@fraudguard/persistence';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { APP_CONFIG } from '../common/config.provider';
import { LOGGER } from '../common/logger.provider';
import { TRANSACTION_REPOSITORY } from '../common/persistence.provider';
import { POLICY_STORE, type PolicyStore } from '../common/policy-store';
import { REDIS_CLIENT } from '../common/redis.provider';

import { buildOutboxEvents } from './build-outbox-events';
import { createScoringProvider } from './scoring-provider.factory';

/** FR-017: duplicate transactionId TTL for the Redis idempotency fast path. */
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * Hot-path pipeline (architecture.md §7): idempotency check, feature load,
 * score, decide, persist, respond. Drives the transaction lifecycle state
 * machine (packages/domain) — every transition is asserted.
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
    this.scoringProvider = createScoringProvider(config, this.logger);
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
    // transitionTransaction() returns the new status — must be captured and
    // carried forward, or the persisted row stays stuck at its original status.
    let status = transitionTransaction(transaction.status, 'VALIDATED');

    // --- VALIDATED -> FEATURES_LOADED ---------------------------------------
    // Only the read happens here (FR-002, ADR-002) — feature writes are the
    // cold path's job (event-worker), so a slow aggregation write never
    // slows an authorization.
    const features = await measure(
      {
        span: 'score.feature_fetch',
        histogram: fraudScoreDurationSeconds,
        labels: { stage: 'feature_fetch' },
      },
      () => this.tryGetFeatureVector(transaction),
    );
    status = transitionTransaction(status, 'FEATURES_LOADED');
    const featuresUnavailable = features.source !== 'live';

    // --- FEATURES_LOADED -> SCORED ------------------------------------------
    const scoringResult = await measure(
      { span: 'score.score', histogram: fraudScoreDurationSeconds, labels: { stage: 'score' } },
      () => this.scoringProvider.score({ transaction, features }),
    );
    const degraded = featuresUnavailable || scoringResult.degradedReason !== undefined;
    const degradedReason: DegradedReason = featuresUnavailable
      ? 'FEATURES_UNAVAILABLE'
      : (scoringResult.degradedReason ?? 'NONE');
    status = transitionTransaction(status, 'SCORED');

    // --- SCORED -> DECIDED ---------------------------------------------------
    // Read fresh on every request (FR-006): a policy change via the admin
    // endpoint takes effect on the next request, no restart needed.
    const policy = this.policyStore.get();
    // decide()/buildReasons() are sync, but still timed via measure() —
    // ADR-003 asks for every stage's timing regardless of cost today.
    const { decision, reasons } = await measure(
      { span: 'score.decide', histogram: fraudScoreDurationSeconds, labels: { stage: 'decide' } },
      () => {
        const decidedValue = decide(scoringResult.score, policy, degraded);
        // FR-007: every non-ALLOW decision carries at least one reason,
        // enforced once here rather than trusted to each provider.
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

    // --- Persist (ADR-006: decision + outbox rows, one transaction) ---------
    // event-worker's relay picks these up later; nothing here talks to Kafka
    // directly (ADR-001, enforced by the hot-path architecture test).
    const outboxEventInputs = buildOutboxEvents(decidedTransaction, fraudDecision, features);
    const persisted = await this.persistOrFailClosed(
      decidedTransaction,
      fraudDecision,
      outboxEventInputs,
      request.transactionId,
    );
    if (persisted.wasExisting) {
      // Redis missed it, but the DB's unique constraint caught the duplicate.
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

  /**
   * ADR-005's PostgreSQL fail-closed policy: unlike the Redis fallback
   * above, this does not swallow the failure — an unrecorded decision is
   * unauditable. isPgConnectivityError() distinguishes "Postgres is
   * unreachable" (503) from "this insert has a real bug" (500).
   */
  private async persistOrFailClosed(
    transaction: Transaction,
    decision: FraudDecision,
    outboxEventInputs: readonly OutboxEventInput[],
    transactionId: string,
  ): Promise<ScoredTransactionResult> {
    try {
      return await measure(
        {
          span: 'score.persist',
          histogram: fraudScoreDurationSeconds,
          labels: { stage: 'persist' },
        },
        () => this.transactionRepository.insertScored(transaction, decision, outboxEventInputs),
      );
    } catch (error) {
      if (isPgConnectivityError(error)) {
        this.logger.error(
          { err: error, transactionId },
          'PostgreSQL unreachable — failing closed per ADR-005, no decision recorded',
        );
        throw new ServiceUnavailableException({
          code: 'DECISION_NOT_RECORDED',
          message: 'Unable to durably record this decision right now. Retry shortly.',
        });
      }
      throw error;
    }
  }

  /** ADR-005's Redis cautious-open fallback — getFeatureVector() throws by design, so the catch lives here. */
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
