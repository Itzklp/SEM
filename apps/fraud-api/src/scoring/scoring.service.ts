import type { AppConfig } from '@fraudguard/config';
import type { ScoreRequest, ScoreResponse } from '@fraudguard/contracts';
import {
  createTransaction,
  Money,
  transitionTransaction,
  type FraudDecision,
  type DegradedReason,
  type Transaction,
} from '@fraudguard/domain';
import {
  getIdempotentResult,
  getPlaceholderFeatureVector,
  storeIdempotentResult,
} from '@fraudguard/feature-store';
import type { DecisionRow, TransactionRepository } from '@fraudguard/persistence';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { APP_CONFIG } from '../common/config.provider';
import { LOGGER } from '../common/logger.provider';
import { TRANSACTION_REPOSITORY } from '../common/persistence.provider';
import { REDIS_CLIENT } from '../common/redis.provider';

import { decide } from './decide';
import { PlaceholderScoringProvider } from './placeholder-scoring-provider';

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
  private readonly scoringProvider = new PlaceholderScoringProvider();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(TRANSACTION_REPOSITORY) private readonly transactionRepository: TransactionRepository,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async score(request: ScoreRequest): Promise<ScoreResponse> {
    const startedAt = Date.now();

    // --- Idempotency fast path (FR-017) ------------------------------------
    const cached = await this.tryGetIdempotentResult(request.transactionId);
    if (cached) {
      this.logger.info(
        { transactionId: request.transactionId },
        'Duplicate transaction — returning cached decision',
      );
      return cached;
    }

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
    // Phase 3 placeholder (packages/feature-store): always 'unavailable'.
    // This is honestly degraded, not faked — there is no real feature
    // computation until Phase 4, so every Phase 3 decision correctly
    // reports degraded=true, FEATURES_UNAVAILABLE (ADR-005).
    const features = getPlaceholderFeatureVector(request.userId);
    status = transitionTransaction(status, 'FEATURES_LOADED');
    const degraded = features.source !== 'live';
    const degradedReason: DegradedReason = degraded ? 'FEATURES_UNAVAILABLE' : 'NONE';

    // --- FEATURES_LOADED -> SCORED ------------------------------------------
    const scoringResult = await this.scoringProvider.score({ transaction, features });
    status = transitionTransaction(status, 'SCORED');

    // --- SCORED -> DECIDED ---------------------------------------------------
    const decision = decide(scoringResult.score, this.config.policy, degraded);
    status = transitionTransaction(status, 'DECIDED');
    const decidedTransaction: Transaction = { ...transaction, status };

    const processingTimeMs = Date.now() - startedAt;
    const fraudDecision: FraudDecision = {
      transactionId: transaction.transactionId,
      decision,
      riskScore: scoringResult.score,
      reasons: scoringResult.riskFactors,
      policyVersion: this.config.policy.version,
      modelVersion: scoringResult.modelVersion,
      scoringProvider: scoringResult.provider,
      degraded,
      degradedReason,
      decidedAt: new Date(),
      processingTimeMs,
    };

    // --- Persist (ADR-006: decision write, one transaction) -----------------
    const persisted = await this.transactionRepository.insertScored(
      decidedTransaction,
      fraudDecision,
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
