import type { RiskFactor } from '../entities/fraud-decision';
import type { Decision } from '../enums';

/**
 * FR-007's floor, made unconditional: "every non-ALLOW decision carries
 * at least one human-readable reason." A decision can be non-ALLOW with
 * zero triggered rules — the model or behavioural signal alone can push
 * the combined score into REVIEW/BLOCK territory (FR-005's three signals
 * are independent) — so the guarantee cannot simply be "pass through
 * whatever the rules produced"; it has to be enforced here, once, for
 * every provider, rather than trusted to each provider individually.
 *
 * Internal detail (which rule, its raw contribution) rides along on
 * every `RiskFactor` returned here — stripping it for the client is
 * `toClientSafeReasons`' job (`entities/fraud-decision.ts`), deliberately
 * kept as a separate, later step so this function's output is still the
 * full, audit-grade basis for the decision.
 */
export function buildReasons(
  riskFactors: readonly RiskFactor[],
  decision: Decision,
): readonly RiskFactor[] {
  if (decision === 'ALLOW' || riskFactors.length > 0) {
    return riskFactors;
  }

  return [
    {
      reason: 'The combined risk score exceeded the policy threshold for this decision',
      internal: { source: 'decision-engine', scoreContribution: 0 },
    },
  ];
}
