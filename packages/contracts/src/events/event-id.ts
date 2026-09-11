import { createHash } from 'node:crypto';

/**
 * ADR-006: "`eventId` is deterministic from (aggregateId, eventType) at
 * the producer, NOT random — so republishing the same logical event
 * after a relay crash produces the same id, and consumer-side dedup
 * actually dedups instead of admitting every retry as 'new'." A real
 * UUID v5 (RFC 4122 §4.3: SHA-1 of a namespace + name), not a hash
 * merely shaped like one — computed with `node:crypto` rather than
 * pulling in the `uuid` package for one function.
 *
 * The namespace UUID is arbitrary but fixed forever: changing it would
 * change every future `eventId` for the same (aggregateId, eventType)
 * pair, silently breaking dedup for anything in flight during the
 * change.
 */
const NAMESPACE_HEX = '6c1b8b3e6e6e4f0a9c9b2f6a2f6a2f6a';

export function deterministicEventId(aggregateId: string, eventType: string): string {
  const namespaceBytes = Buffer.from(NAMESPACE_HEX, 'hex');
  const nameBytes = Buffer.from(`${aggregateId}:${eventType}`, 'utf8');
  const hash = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, nameBytes]))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8); // RFC 4122 variant

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
