import type { AppConfig } from '@fraudguard/config';
import { InvalidPolicyError, isValidRiskPolicy, type RiskPolicy } from '@fraudguard/domain';
import { Injectable, type Provider } from '@nestjs/common';

import { APP_CONFIG } from './config.provider';

/**
 * FR-006: "Thresholds are configurable at runtime without redeployment."
 * The only mutable piece of configuration in this process — everything
 * else (`AppConfig`) is loaded once at boot and never changes
 * (`config.provider.ts`'s doc comment). `ScoringService` reads `get()`
 * fresh on every request rather than caching a policy at construction,
 * which is what makes a `set()` from the admin endpoint
 * (`admin/policy.controller.ts`) take effect on the very next request —
 * no restart, no redeploy.
 *
 * Deliberately scoped to the decision POLICY only (allow/block
 * thresholds, the degraded band, the policy version) — NOT the score
 * combination weights or the rule thresholds. Those are consumed once,
 * at construction, by `RuleBasedScoringProvider` and the six `FraudRule`
 * instances (`scoring-provider.factory.ts`); making them hot-reloadable
 * too would mean reconstructing the provider and every rule per request,
 * or threading a live reference through objects that are deliberately
 * pure and config-free today. A real, smaller feature now, honestly
 * short of the larger one, rather than a half-built version of both.
 *
 * Single-process, in-memory, by design: this prototype runs one
 * `fraud-api` instance (DEVELOPMENT_ENVIRONMENT.md's capacity
 * constraint). Propagating a policy change across multiple instances
 * (shared state, or a pub/sub invalidation) is a real problem a
 * horizontally-scaled deployment would have to solve — out of scope
 * here, and worth flagging rather than silently assuming away.
 */
@Injectable()
export class PolicyStore {
  private current: RiskPolicy;

  constructor(initial: RiskPolicy) {
    // Should never fail — packages/config validates the same invariant
    // at load time (load-config.ts's superRefine). Checked again anyway:
    // trusting a caller never to pass something invalid is how that
    // assumption eventually breaks.
    if (!isValidRiskPolicy(initial)) {
      throw new InvalidPolicyError('Initial policy from configuration is invalid');
    }
    this.current = initial;
  }

  get(): RiskPolicy {
    return this.current;
  }

  /** Throws `InvalidPolicyError` (never adopts a bad policy) rather than returning a boolean — a caller that ignores a boolean silently ships an invalid policy. */
  set(next: RiskPolicy): void {
    if (!isValidRiskPolicy(next)) {
      throw new InvalidPolicyError(
        'Rejected: policy must have allowMax < blockMin, both in [0,1], and the degraded band must be at least as strict as the healthy one (ADR-005)',
      );
    }
    this.current = next;
  }
}

export const POLICY_STORE = Symbol('POLICY_STORE');

export const policyStoreProvider: Provider = {
  provide: POLICY_STORE,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): PolicyStore =>
    new PolicyStore({
      policyVersion: config.policy.version,
      allowMax: config.policy.allowMax,
      blockMin: config.policy.blockMin,
      degraded: config.policy.degraded,
    }),
};
