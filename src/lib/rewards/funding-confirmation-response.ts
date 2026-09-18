import "server-only";

import type { FundingConfirmationResult } from "@/lib/rewards/funding-confirmation";
import type { FundingReconciliationResult } from "@/lib/rewards/reconciliation";

/**
 * HTTP boundary projection for funding confirmation results.
 *
 * The engine keeps monetary values as bigints (exact arithmetic, no
 * precision loss). `NextResponse.json()` cannot serialize bigints, so the
 * known Luna positions are projected to base-10 strings here. Nothing is
 * converted through Number, accounting is untouched, and every other field
 * passes through byte-identical. The projection never throws: unknown
 * positions are left as-is.
 */
function luna(value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function decisionDto(decision: FundingReconciliationResult) {
  return {
    ...decision,
    expectedAmountLuna: luna(decision.expectedAmountLuna),
    observedAmountLuna: luna(decision.observedAmountLuna),
    excessAmountLuna: luna(decision.excessAmountLuna),
  };
}

export function toJsonSafeFundingConfirmation(
  result: FundingConfirmationResult,
): unknown {
  switch (result.kind) {
    case "confirmed":
      return { kind: result.kind, decision: decisionDto(result.decision), atomic: result.atomic };
    case "replay":
      return {
        kind: result.kind,
        campaignId: result.campaignId,
        intentId: result.intentId,
        transactionHash: result.transactionHash,
        actualAmountLuna: luna(result.actualAmountLuna),
        excessAmountLuna: luna(result.excessAmountLuna),
        fundedAt: result.fundedAt,
        confirmedAt: result.confirmedAt,
      };
    case "reconciled":
      return { kind: result.kind, decision: decisionDto(result.decision) };
    default:
      return result;
  }
}
