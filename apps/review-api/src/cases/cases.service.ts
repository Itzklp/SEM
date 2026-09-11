import {
  caseReviewedEvent,
  deterministicEventId,
  TOPIC_FOR_EVENT_TYPE,
} from '@fraudguard/contracts';
import {
  applyCaseAction,
  IllegalTransitionError,
  type CaseAction,
  type CaseStatus,
} from '@fraudguard/domain';
import { captureTraceparent, currentTraceId } from '@fraudguard/observability';
import type { CaseRepository, FraudCaseRow, PagedResult } from '@fraudguard/persistence';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { CASE_REPOSITORY } from '../common/persistence.provider';

/**
 * FR-010, FR-011. The illegal-transition check happens here, against
 * `packages/domain`'s `applyCaseAction` — BEFORE any write — so a
 * request to review an already-closed case is rejected with no side
 * effect, not caught only by the repository's DB-level guard. That
 * guard (`CaseRepository.applyReview`'s `WHERE status = 'OPEN'`) is the
 * race-safe backstop for the case two concurrent requests both pass
 * THIS check against the same stale read — this service's own check and
 * the repository's guard are deliberately two different layers, not one
 * duplicated twice.
 */
@Injectable()
export class CasesService {
  constructor(@Inject(CASE_REPOSITORY) private readonly caseRepository: CaseRepository) {}

  async list(status: string, page: number, pageSize: number): Promise<PagedResult<FraudCaseRow>> {
    return this.caseRepository.listByStatus(status, page, pageSize);
  }

  async getById(caseId: string): Promise<FraudCaseRow> {
    const fraudCase = await this.caseRepository.findById(caseId);
    if (!fraudCase) {
      throw new NotFoundException({ code: 'CASE_NOT_FOUND', message: `No case with id ${caseId}` });
    }
    return fraudCase;
  }

  async review(
    caseId: string,
    action: CaseAction,
    reviewerId: string,
    reason: string,
  ): Promise<FraudCaseRow> {
    const existing = await this.getById(caseId);

    let targetStatus: CaseStatus;
    try {
      targetStatus = applyCaseAction(existing.status as CaseStatus, action);
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      throw error;
    }

    const reviewedAt = new Date();
    const eventId = deterministicEventId(caseId, 'fraud.case.reviewed');
    // This is a NEW trace — the analyst's HTTP request to review-api, not
    // a continuation of the original scoring request's trace (that one
    // ended when fraud-api responded, possibly minutes/hours ago).
    // `currentTraceId()`/`captureTraceparent()` read THIS request's span,
    // set by `startTracing()`'s HttpInstrumentation — same replacement of
    // the old transactionId placeholder as
    // apps/fraud-api/src/scoring/build-outbox-events.ts.
    const traceContext = captureTraceparent();
    const outboxEvent = {
      eventId,
      aggregateId: existing.transactionId,
      eventType: 'fraud.case.reviewed',
      topic: TOPIC_FOR_EVENT_TYPE['fraud.case.reviewed'],
      partitionKey: existing.transactionId,
      // `exactOptionalPropertyTypes`: omit the key entirely rather than
      // assign `undefined` to it — see build-outbox-events.ts's identical
      // pattern.
      ...(traceContext ? { traceContext } : {}),
      payload: caseReviewedEvent.parse({
        eventId,
        eventType: 'fraud.case.reviewed',
        aggregateId: existing.transactionId,
        occurredAt: reviewedAt.toISOString(),
        traceId: currentTraceId() ?? existing.transactionId,
        payload: {
          caseId,
          transactionId: existing.transactionId,
          action,
          resultingStatus: targetStatus,
          reviewerId,
          reason,
        },
      }),
    };

    const updated = await this.caseRepository.applyReview(
      caseId,
      targetStatus,
      reviewerId,
      reason,
      reviewedAt,
      outboxEvent,
    );
    if (!updated) {
      // The domain check above passed against a read that is now stale —
      // someone else's review landed first. Not this service's job to
      // silently pick a winner; the caller finds out and can re-fetch.
      throw new ConflictException({
        code: 'CASE_ALREADY_REVIEWED',
        message: 'This case was already reviewed',
      });
    }
    return updated;
  }
}
