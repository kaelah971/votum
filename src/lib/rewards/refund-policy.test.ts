import { describe, expect, it } from "vitest";
import {
  calculateRefundableRewardAmount,
  classifyRewardObligations,
  evaluateRewardClosure,
  type RewardClosureInput,
} from "@/lib/rewards/refund-policy";

const HASH = "a".repeat(64);

function makeInput(overrides: Partial<RewardClosureInput> = {}): RewardClosureInput {
  return {
    campaign: {
      status: "funded",
      participationWindowClosed: true,
      closureTrigger: "poll_closed",
      firstReservationAt: null,
      fundedAmountLuna: BigInt(11200),
      rewardPrincipalLuna: BigInt(10000),
      feeReserveLuna: BigInt(1000),
      refundableExcessLuna: BigInt(200),
      paidAmountLuna: BigInt(0),
      feeSpentLuna: BigInt(0),
      protectedFeeReserveLuna: BigInt(0),
    },
    receipts: [],
    vaultBalanceLuna: BigInt(11200),
    ...overrides,
  };
}

function paidReceipt(amountLuna = BigInt(1000)) {
  return { status: "paid" as const, amountLuna, payoutAttempts: [] };
}

describe("reward closure and refund policy", () => {
  it("allows a funded zero-claim campaign to close after its window ends", () => {
    const result = evaluateRewardClosure(makeInput());

    expect(result.kind).toBe("closable");
    expect(result.reasonCode).toBe("closable");
    expect(result.refundableAmountLuna).toBe(BigInt(11200));
  });

  it("reserved receipt blocks refund", () => {
    const result = evaluateRewardClosure(makeInput({
      receipts: [{ status: "reserved", amountLuna: BigInt(1000), payoutAttempts: [] }],
    }));

    expect(result.kind).toBe("blocked");
    expect(result.reasonCode).toBe("unresolved_reward_obligations");
  });

  it("payout_pending receipt blocks refund", () => {
    const result = evaluateRewardClosure(makeInput({
      receipts: [{ status: "payout_pending", amountLuna: BigInt(1000), payoutAttempts: [] }],
    }));

    expect(result.kind).toBe("blocked");
    expect(result.reasonCode).toBe("unresolved_reward_obligations");
  });

  it("hash-bearing unknown payout requires reconciliation", () => {
    const result = evaluateRewardClosure(makeInput({
      receipts: [{
        status: "payout_pending",
        amountLuna: BigInt(1000),
        payoutAttempts: [{
          status: "pending",
          transactionHash: HASH,
          broadcastStartedAt: "2026-09-12T00:00:00.000Z",
          broadcastAt: null,
          chainStatus: "unknown",
          manualReviewRequired: false,
        }],
      }],
    }));

    expect(result.kind).toBe("blocked");
    expect(result.reasonCode).toBe("payout_reconciliation_required");
  });

  it("retryable or manual-review payout blocks refund", () => {
    const result = evaluateRewardClosure(makeInput({
      receipts: [{
        status: "retryable",
        amountLuna: BigInt(1000),
        payoutAttempts: [{
          status: "retryable",
          transactionHash: null,
          broadcastStartedAt: null,
          broadcastAt: null,
          chainStatus: null,
          manualReviewRequired: true,
        }],
      }],
    }));

    expect(result.kind).toBe("blocked");
    expect(result.reasonCode).toBe("payout_reconciliation_required");
  });

  it("paid receipts do not block closure", () => {
    const result = evaluateRewardClosure(makeInput({
      campaign: {
        ...makeInput().campaign,
        status: "rewarding",
        paidAmountLuna: BigInt(1000),
      },
      receipts: [paidReceipt()],
    }));

    expect(result.kind).toBe("closable");
    expect(result.obligations.unresolvedReceiptCount).toBe(0);
  });

  it("returns unused participant capacity as refundable principal", () => {
    const calculation = calculateRefundableRewardAmount(makeInput().campaign, BigInt(11200));

    expect(calculation.kind).toBe("calculated");
    expect(calculation.unusedRewardPrincipalLuna).toBe(BigInt(10000));
    expect(calculation.refundableAmountLuna).toBe(BigInt(11200));
  });

  it("includes overpayment exactly once", () => {
    const calculation = calculateRefundableRewardAmount(makeInput().campaign, BigInt(11200));

    expect(calculation.kind).toBe("calculated");
    expect(calculation.refundableExcessLuna).toBe(BigInt(200));
    expect(calculation.refundableAmountLuna).toBe(BigInt(11200));
    expect(
      calculation.unusedRewardPrincipalLuna +
        calculation.unusedFeeReserveLuna +
        calculation.refundableExcessLuna,
    ).toBe(calculation.ledgerRefundableAmountLuna);
  });

  it("returns only the unused fee reserve after confirmed fee spend", () => {
    const campaign = {
      ...makeInput().campaign,
      feeSpentLuna: BigInt(200),
    };
    const calculation = calculateRefundableRewardAmount(campaign, BigInt(11000));

    expect(calculation.kind).toBe("calculated");
    expect(calculation.unusedFeeReserveLuna).toBe(BigInt(800));
    expect(calculation.refundableAmountLuna).toBe(BigInt(11000));
  });

  it("protects fee reserve explicitly held for unresolved work", () => {
    const campaign = {
      ...makeInput().campaign,
      feeSpentLuna: BigInt(200),
      protectedFeeReserveLuna: BigInt(600),
    };
    const calculation = calculateRefundableRewardAmount(campaign, BigInt(11000));

    expect(calculation.kind).toBe("calculated");
    expect(calculation.unusedFeeReserveLuna).toBe(BigInt(200));
    expect(calculation.refundableAmountLuna).toBe(BigInt(10400));
  });

  it("caps refund at the proven vault balance", () => {
    const result = evaluateRewardClosure(makeInput({ vaultBalanceLuna: BigInt(5000) }));

    expect(result.kind).toBe("closable");
    expect(result.refundableAmountLuna).toBe(BigInt(5000));
    expect(result.refundableAmountLuna).toBeLessThanOrEqual(BigInt(5000));
  });

  it("never returns a negative refundable amount for malformed accounting", () => {
    const campaign = {
      ...makeInput().campaign,
      paidAmountLuna: BigInt(20000),
    };
    const calculation = calculateRefundableRewardAmount(campaign, BigInt(11200));

    expect(calculation.kind).toBe("invalid");
    expect(calculation.refundableAmountLuna).toBe(BigInt(0));
    expect(calculation.refundableAmountLuna).toBeGreaterThanOrEqual(BigInt(0));
  });

  it("does not initiate a second refund for refunded or closed campaigns", () => {
    for (const status of ["closed", "refunded"] as const) {
      const result = evaluateRewardClosure(makeInput({
        campaign: { ...makeInput().campaign, status },
      }));

      expect(result.kind).toBe("already_closed");
      expect(result.reasonCode).toBe("already_refunded_or_closed");
    }
  });

  it("returns a deterministic zero-refund result", () => {
    const result = evaluateRewardClosure(makeInput({
      campaign: {
        ...makeInput().campaign,
        status: "exhausted",
        fundedAmountLuna: BigInt(1000),
        rewardPrincipalLuna: BigInt(1000),
        feeReserveLuna: BigInt(0),
        refundableExcessLuna: BigInt(0),
        paidAmountLuna: BigInt(1000),
      },
      receipts: [paidReceipt(BigInt(1000))],
      vaultBalanceLuna: BigInt(0),
    }));

    expect(result.kind).toBe("nothing_to_refund");
    expect(result.reasonCode).toBe("no_refundable_balance");
    expect(result.refundableAmountLuna).toBe(BigInt(0));
  });

  it("does not allow cancellation after first_reservation_at", () => {
    const result = evaluateRewardClosure(makeInput({
      campaign: {
        ...makeInput().campaign,
        status: "cancelled",
        closureTrigger: "cancelled",
        firstReservationAt: "2026-09-12T00:00:00.000Z",
      },
    }));

    expect(result.kind).toBe("blocked");
    expect(result.reasonCode).toBe("campaign_not_closable");
  });

  it("allows cancellation before first reservation", () => {
    const result = evaluateRewardClosure(makeInput({
      campaign: {
        ...makeInput().campaign,
        status: "cancelled",
        closureTrigger: "cancelled",
      },
    }));

    expect(result.kind).toBe("closable");
  });

  it("allows exhausted campaigns after all rewards are paid", () => {
    const result = evaluateRewardClosure(makeInput({
      campaign: {
        ...makeInput().campaign,
        status: "exhausted",
        paidAmountLuna: BigInt(10000),
      },
      receipts: Array.from({ length: 10 }, () => paidReceipt()),
      vaultBalanceLuna: BigInt(1200),
    }));

    expect(result.kind).toBe("closable");
    expect(result.refundableAmountLuna).toBe(BigInt(1200));
  });

  it("allows an expired campaign after all obligations are settled", () => {
    const result = evaluateRewardClosure(makeInput({
      campaign: {
        ...makeInput().campaign,
        status: "rewarding",
        closureTrigger: "expired",
      },
      receipts: [paidReceipt()],
      vaultBalanceLuna: BigInt(10200),
    }));

    expect(result.kind).toBe("closable");
  });

  it("uses integer Luna values throughout the calculation", () => {
    const result = evaluateRewardClosure(makeInput());

    expect(typeof result.refundableAmountLuna).toBe("bigint");
    expect(typeof result.accounting.ledgerRefundableAmountLuna).toBe("bigint");
  });

  it("is deterministic for repeated identical input", () => {
    const input = makeInput({ receipts: [paidReceipt()] });

    expect(evaluateRewardClosure(input)).toEqual(evaluateRewardClosure(input));
  });

  it("does not inspect or vary on selected poll option data", () => {
    const input = makeInput({ receipts: [paidReceipt()] });
    const optionA = evaluateRewardClosure({ ...input, selectedOptionId: "option-a" } as RewardClosureInput);
    const optionB = evaluateRewardClosure({ ...input, selectedOptionId: "option-b" } as RewardClosureInput);

    expect(optionA).toEqual(optionB);
  });

  it("classifies all unresolved receipt states before any refund calculation", () => {
    const summary = classifyRewardObligations(makeInput({
      receipts: [
        { status: "eligible", amountLuna: BigInt(1000), payoutAttempts: [] },
        { status: "failed", amountLuna: BigInt(1000), payoutAttempts: [] },
        { status: "reserved", amountLuna: BigInt(1000), payoutAttempts: [] },
      ],
    }).receipts);

    expect(summary.unresolvedReceiptCount).toBe(1);
    expect(summary.unresolvedAmountLuna).toBe(BigInt(1000));
    expect(summary.reasonCode).toBe("unresolved_reward_obligations");
  });

  it("requires reconciliation for terminal failure with payout evidence", () => {
    const summary = classifyRewardObligations(makeInput({
      receipts: [{
        status: "failed",
        amountLuna: BigInt(1000),
        payoutAttempts: [{
          status: "failed",
          transactionHash: HASH,
          broadcastStartedAt: "2026-09-12T00:00:00.000Z",
          broadcastAt: null,
          chainStatus: "unknown",
          manualReviewRequired: false,
        }],
      }],
    }).receipts);

    expect(summary.unresolvedReceiptCount).toBe(0);
    expect(summary.reconciliationRequiredReceiptCount).toBe(1);
    expect(summary.reasonCode).toBe("payout_reconciliation_required");
  });
});
