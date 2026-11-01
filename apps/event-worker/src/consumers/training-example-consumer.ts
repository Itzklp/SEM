import { caseReviewedEvent, transactionDecidedEvent } from '@fraudguard/contracts';
import type { ModelTrainingRepository } from '@fraudguard/persistence';

/** Only analyst APPROVE/BLOCK actions are labels; ESCALATE is intentionally ignored. */
export async function handleTrainingExample(
  repository: ModelTrainingRepository,
  topic: string,
  payload: unknown,
): Promise<void> {
  if (topic === 'transaction.decided') {
    const event = transactionDecidedEvent.parse(payload);
    const row = event.payload.trainingFeatures;
    if (!row) return; // compatible with events created before Phase 10
    await repository.recordFeatures({
      transactionId: event.payload.transactionId,
      ...row,
      predictedDecision: event.payload.decision,
      modelVersion: event.payload.modelVersion,
    });
    return;
  }
  if (topic === 'review.completed') {
    const event = caseReviewedEvent.parse(payload);
    if (event.payload.action === 'APPROVE' || event.payload.action === 'BLOCK') {
      await repository.recordReview(event.payload.transactionId, event.payload.action);
    }
  }
}
