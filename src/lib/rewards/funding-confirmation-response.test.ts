import { describe, expect, it } from "vitest";
import { toJsonSafeFundingConfirmation } from "@/lib/rewards/funding-confirmation-response";
import type { FundingReconciliationResult } from "@/lib/rewards/reconciliation";

const HUGE = BigInt("9223372036854775807");

function decision(overrides: Partial<FundingReconciliationResult> = {}): FundingReconciliationResult {
  return {
    status: "confirmed",
    reasonCode: "confirmed_success",
    confirmed: true,
    expectedTransactionHash: "ab".repeat(32),
    observedTransactionHash: "ab".repeat(32),
    expectedAmountLuna: BigInt(580000),
    observedAmountLuna: BigInt(580000),
    excessAmountLuna: BigInt(0),
    amountComparison: "exact",
    ...overrides,
  };
}

describe("toJsonSafeFundingConfirmation", () => {
  it("projects confirmed decisions to decimal strings without precision loss", () => {
    const dto = toJsonSafeFundingConfirmation({
      kind: "confirmed",
      decision: decision({ expectedAmountLuna: HUGE, observedAmountLuna: HUGE, excessAmountLuna: HUGE }),
      atomic: { kind: "confirmed", data: { result_kind: "confirmed" } },
    }) as Record<string, Record<string, unknown>>;

    expect(dto.decision.expectedAmountLuna).toBe("9223372036854775807");
    expect(dto.decision.observedAmountLuna).toBe("9223372036854775807");
    expect(dto.decision.excessAmountLuna).toBe("9223372036854775807");
    expect(dto.decision.status).toBe("confirmed");
    expect(dto.decision.amountComparison).toBe("exact");
    expect(() => JSON.stringify(dto)).not.toThrow();
  });

  it("projects replay amounts and preserves null observations", () => {
    const replay = toJsonSafeFundingConfirmation({
      kind: "replay",
      campaignId: "campaign-1",
      intentId: "intent-1",
      transactionHash: "ab".repeat(32),
      actualAmountLuna: HUGE,
      excessAmountLuna: BigInt(0),
      fundedAt: "2026-09-18T00:00:00.000Z",
      confirmedAt: null,
    }) as Record<string, unknown>;

    expect(replay.actualAmountLuna).toBe("9223372036854775807");
    expect(replay.excessAmountLuna).toBe("0");
    expect(replay.transactionHash).toBe("ab".repeat(32));

    const reconciled = toJsonSafeFundingConfirmation({
      kind: "reconciled",
      decision: decision({ observedAmountLuna: null }),
    }) as Record<string, Record<string, unknown>>;
    expect(reconciled.decision.observedAmountLuna).toBeNull();
    expect(reconciled.decision.expectedAmountLuna).toBe("580000");
    expect(() => JSON.stringify({ replay, reconciled })).not.toThrow();
  });

  it("passes error shapes through unchanged", () => {
    expect(toJsonSafeFundingConfirmation({ kind: "not_confirmable", reasonCode: "intent_unbound" })).toEqual({
      kind: "not_confirmable",
      reasonCode: "intent_unbound",
    });
    expect(toJsonSafeFundingConfirmation({ kind: "error", reasonCode: "x", message: "y" })).toEqual({
      kind: "error",
      reasonCode: "x",
      message: "y",
    });
  });
});
