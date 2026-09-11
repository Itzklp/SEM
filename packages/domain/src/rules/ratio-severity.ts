import type { RuleSeverity } from '../enums';

/**
 * Shared scoring shape for every threshold-style rule below: given how far
 * a value sits past its trigger threshold, express that as a severity
 * band and a [0,1] score contribution. Centralised so the six rules stay
 * consistent with each other rather than each inventing its own scale —
 * and so a future seventh rule (UT-RULE-031: "adding a rule requires no
 * engine change") gets the same behaviour for free.
 *
 * `ratio` is `value / threshold`. At exactly the threshold (`ratio === 1`)
 * the rule has just triggered — `contribution` is 0 there by design
 * (crossing the line is not yet "severe"); it rises linearly and is
 * clamped at 1 once the value has reached double the threshold. This is a
 * deliberately simple, reviewable curve, not a fitted or researched one —
 * same honesty as `feature-definitions.ts`'s defaults.
 */
export function ratioToSeverity(ratio: number): { severity: RuleSeverity; contribution: number } {
  const contribution = Math.min(1, Math.max(0, ratio - 1));
  if (ratio >= 2) {
    return { severity: 'CRITICAL', contribution };
  }
  if (ratio >= 1.5) {
    return { severity: 'HIGH', contribution };
  }
  if (ratio >= 1.2) {
    return { severity: 'MEDIUM', contribution };
  }
  return { severity: 'LOW', contribution };
}
