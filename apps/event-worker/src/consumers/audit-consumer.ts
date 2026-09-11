import {
  caseCreatedEvent,
  caseReviewedEvent,
  transactionDecidedEvent,
  transactionReceivedEvent,
} from '@fraudguard/contracts';
import type { AuditRepository } from '@fraudguard/persistence';

/**
 * DELIBERATE DEVIATION from `docs/architecture/kafka-topics.md`'s
 * original catalogue, recorded in `@fraudguard/contracts`'
 * `topics.ts` and repeated here: rather than a generic `audit.events`
 * topic every producer writes to in parallel with its domain-specific
 * event, this consumer subscribes directly to the four domain topics
 * Phase 6 actually produces and derives its own `audit_events` rows from
 * them. `event.eventId` is reused as the `audit_events.event_id` —
 * dedup on replay is then "the same underlying event was already
 * audited", which is exactly the guarantee FR-008 needs, not a
 * separately-generated audit-specific id.
 */
export async function handleAuditableEvent(
  auditRepository: AuditRepository,
  topic: string,
  payload: unknown,
): Promise<void> {
  switch (topic) {
    case 'transaction.received': {
      const event = transactionReceivedEvent.parse(payload);
      await auditRepository.append({
        eventId: event.eventId,
        aggregateType: 'transaction',
        aggregateId: event.payload.transactionId,
        action: 'transaction.received',
        actorId: null,
        detail: event.payload,
        occurredAt: new Date(event.occurredAt),
      });
      return;
    }
    case 'transaction.decided': {
      const event = transactionDecidedEvent.parse(payload);
      await auditRepository.append({
        eventId: event.eventId,
        aggregateType: 'transaction',
        aggregateId: event.payload.transactionId,
        action: 'transaction.decided',
        actorId: null,
        detail: event.payload,
        occurredAt: new Date(event.occurredAt),
      });
      return;
    }
    case 'review.created': {
      const event = caseCreatedEvent.parse(payload);
      await auditRepository.append({
        eventId: event.eventId,
        aggregateType: 'case',
        aggregateId: event.payload.caseId,
        action: 'case.created',
        actorId: null,
        detail: event.payload,
        occurredAt: new Date(event.occurredAt),
      });
      return;
    }
    case 'review.completed': {
      const event = caseReviewedEvent.parse(payload);
      await auditRepository.append({
        eventId: event.eventId,
        aggregateType: 'case',
        aggregateId: event.payload.caseId,
        action: 'case.reviewed',
        actorId: event.payload.reviewerId,
        detail: event.payload,
        occurredAt: new Date(event.occurredAt),
      });
      return;
    }
    default:
      throw new Error(
        `audit-consumer: unrecognised topic "${topic}" — not one of the four it subscribed to`,
      );
  }
}
