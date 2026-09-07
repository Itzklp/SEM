import { z } from 'zod';

import { idSchema } from '../common';

import { defineEvent } from './envelope';

/**
 * Topic: `audit.events` · Partition key: aggregateId (transactionId or caseId)
 * Producer: every service, via outbox relay, for any state-changing action
 * Consumers: audit persistence (event-worker) — append-only, never updated or deleted (FR-008)
 *
 * This is deliberately generic (`action` + free-form `detail`) rather than
 * one schema per audited action, because the audit log's job is to capture
 * "what happened, to what, when, and why" uniformly across every domain
 * event — not to duplicate the specific schemas above. Kafka topic
 * catalogue: docs/architecture/kafka-topics.md.
 */
export const auditEvent = defineEvent(
  'audit.event',
  z.object({
    aggregateType: z.enum(['transaction', 'case', 'model', 'policy']),
    aggregateId: idSchema,
    action: z.string(),
    actorId: z.string().nullable(),
    detail: z.record(z.string(), z.unknown()),
  }),
);
export type AuditEvent = z.infer<typeof auditEvent>;
