import { describe, expect, it, vi } from "vitest";
import { Address } from "@nimiq/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  reconcileRewardPayout,
  type ExpectedPayout,
  type ObservedFundingTransaction,
  type FundingObservation,
} from "@/lib/rewards/reconciliation";
import {
  reconcilePayoutAttempt,
  type PayoutReconciliationContext,
  type PayoutReconciliationDependencies,
} from "@/lib/rewards/payout-reconciliation";

const CAMPAIGN_ID = "campaign-payout-test";
const RECEIPT_ID = "receipt-payout-test";
const ATTEMPT_ID = "attempt-payout-test";
const NETWORK_ID = 42;
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const VAULT_HEX = "ab".repeat(20);
const PARTICIPANT_HEX = "cd".repeat(20);
const OTHER_HEX = "ef".repeat(20);
const PARTICIPANT_NQ = Address.fromString(PARTICIPANT_HEX).toUserFriendlyAddress();

const expectedPayout: ExpectedPayout = {
  campaignId: CAMPAIGN_ID,
  receiptId: RECEIPT_ID,
  attemptId: ATTEMPT_ID,
  networkId: NETWORK_ID,
  transactionHash: HASH,
  vaultAddress: VAULT_HEX,
  participantWallet: PARTICIPANT_HEX,
  amountLuna: BigInt(9000),
};

function finalityEvidence() {
  return {
    transactionBlockHeight: 100,
    transactionBlockHash: null,
    canonicalBlockHash: "c".repeat(64),
    canonicalBlockVerified: true,
    batchNumber: 7,
    finalizingMacroBlockHeight: 105,
    finalizingMacroBlockHash: "d".repeat(64),
  };
}

function observedTransaction(
  overrides: Partial<ObservedFundingTransaction> = {},
): ObservedFundingTransaction {
  return {
    transactionHash: HASH,
    blockHash: null,
    networkId: NETWORK_ID,
    sender: VAULT_HEX,
    recipient: PARTICIPANT_NQ,
    valueLuna: BigInt(9000),
    memo: null,
    executionResult: true,
    blockHeight: 100,
    timestampMs: 1_725_000_000_000,
    confirmationCount: null,
    finality: "final",
    finalityReason: null,
    finalityEvidence: finalityEvidence(),
    ...overrides,
  };
}

function found(
  overrides: Partial<ObservedFundingTransaction> = {},
): FundingObservation {
  return { kind: "found", transaction: observedTransaction(overrides) };
}

function context(
  overrides: Partial<PayoutReconciliationContext> = {},
): PayoutReconciliationContext {
  return {
    attemptId: ATTEMPT_ID,
    receiptId: RECEIPT_ID,
    campaignId: CAMPAIGN_ID,
    attemptStatus: "pending",
    receiptStatus: "payout_pending",
    participantWallet: PARTICIPANT_HEX,
    amountLuna: BigInt(9000),
    vaultAddress: VAULT_HEX,
    networkId: NETWORK_ID,
    transactionHash: HASH,
    broadcastStartedAt: "2026-09-12T00:00:00.000Z",
    broadcastAt: "2026-09-12T00:00:01.000Z",
    confirmedAt: null,
    paidAt: null,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<PayoutReconciliationDependencies> = {},
): PayoutReconciliationDependencies {
  return {
    observePayoutByHash: vi.fn(async () => found()),
    confirmAtomic: vi.fn(async () => ({ kind: "confirmed" as const, data: {} })),
    createLockToken: () => "lock-token",
    acquireVaultLock: vi.fn(async () => true),
    releaseVaultLock: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("reconcileRewardPayout", () => {
  it("confirms an exact finalized payout", () => {
    expect(reconcileRewardPayout(expectedPayout, found())).toMatchObject({
      status: "confirmed",
      reasonCode: "confirmed_success",
      confirmed: true,
      amountComparison: "exact",
    });
  });

  it("requires canonical and macro finality evidence", () => {
    expect(reconcileRewardPayout(expectedPayout, found({ finalityEvidence: null }))).toMatchObject({
      status: "pending",
      reasonCode: "finality_unknown",
      confirmed: false,
    });
  });

  it("keeps a non-final payout pending", () => {
    expect(reconcileRewardPayout(expectedPayout, found({
      finality: "not_final",
      finalityReason: "observed_not_final",
    }))).toMatchObject({ status: "pending", confirmed: false });
  });

  it("keeps a transaction not found safely reconcilable", () => {
    expect(reconcileRewardPayout(expectedPayout, { kind: "not_found" })).toMatchObject({
      status: "pending",
      reasonCode: "transaction_not_found_yet",
      confirmed: false,
    });
  });

  it("keeps RPC failures unpaid and retryable", () => {
    expect(reconcileRewardPayout(expectedPayout, {
      kind: "rpc_error",
      code: "rpc_timeout",
    })).toMatchObject({ status: "retryable", confirmed: false });
  });

  it("rejects a wrong transaction hash", () => {
    expect(reconcileRewardPayout(expectedPayout, found({ transactionHash: OTHER_HASH }))).toMatchObject({
      status: "rejected",
      reasonCode: "hash_mismatch",
      confirmed: false,
    });
  });

  it("rejects a wrong sender", () => {
    expect(reconcileRewardPayout(expectedPayout, found({ sender: OTHER_HEX }))).toMatchObject({
      status: "rejected",
      reasonCode: "wrong_sender",
      confirmed: false,
    });
  });

  it("rejects a wrong recipient", () => {
    expect(reconcileRewardPayout(expectedPayout, found({ recipient: Address.fromString(OTHER_HEX).toUserFriendlyAddress() }))).toMatchObject({
      status: "rejected",
      reasonCode: "wrong_recipient",
      confirmed: false,
    });
  });

  it.each([
    [BigInt(8999), "amount_underpaid"],
    [BigInt(9001), "amount_overpaid"],
  ])("rejects payout amount %s", (amount, reasonCode) => {
    expect(reconcileRewardPayout(expectedPayout, found({ valueLuna: amount }))).toMatchObject({
      status: "rejected",
      reasonCode,
      confirmed: false,
    });
  });

  it("rejects the wrong network", () => {
    expect(reconcileRewardPayout(expectedPayout, found({ networkId: NETWORK_ID + 1 }))).toMatchObject({
      status: "rejected",
      reasonCode: "wrong_network",
      confirmed: false,
    });
  });

  it("rejects execution failure", () => {
    expect(reconcileRewardPayout(expectedPayout, found({ executionResult: false }))).toMatchObject({
      status: "rejected",
      reasonCode: "execution_failed",
      confirmed: false,
    });
  });

  it("keeps unknown execution status unpaid", () => {
    expect(reconcileRewardPayout(expectedPayout, found({ executionResult: null }))).toMatchObject({
      status: "unknown",
      reasonCode: "execution_unknown",
      confirmed: false,
    });
  });

  it("keeps canonical block mismatches pending through a reorg", () => {
    expect(reconcileRewardPayout(expectedPayout, found({
      finality: "not_final",
      finalityReason: "canonical_block_mismatch",
    }))).toMatchObject({
      status: "pending",
      reasonCode: "canonical_block_mismatch",
      confirmed: false,
    });
  });

  it("rejects malformed observations without payment", () => {
    expect(reconcileRewardPayout(expectedPayout, {
      kind: "malformed",
      reasonCode: "malformed_transaction",
    })).toMatchObject({
      status: "rejected",
      reasonCode: "malformed_transaction",
      confirmed: false,
    });
  });

  it("does not use confirmation counts as finality", () => {
    expect(reconcileRewardPayout(expectedPayout, found({
      finality: "final",
      finalityEvidence: null,
      confirmationCount: 999,
    }))).toMatchObject({ status: "pending", confirmed: false });
  });

  it("does not depend on selected-option or poll-outcome data", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/rewards/reconciliation.ts"), "utf8");
    expect(source).not.toMatch(/option_id|selectedOption|winner|majority/);
  });
});

describe("server payout reconciliation boundary", () => {
  it("atomically confirms an exact finalized payout", async () => {
    const deps = dependencies();
    const result = await reconcilePayoutAttempt(context(), deps);

    expect(result.kind).toBe("confirmed");
    expect(deps.confirmAtomic).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: ATTEMPT_ID,
      receiptId: RECEIPT_ID,
      campaignId: CAMPAIGN_ID,
      transactionHash: HASH,
      observedAmountLuna: BigInt(9000),
      networkId: NETWORK_ID,
      blockNumber: 100,
      batchNumber: 7,
      finalizingMacroBlockHeight: 105,
    }));
  });

  it("returns an idempotent replay for an already-paid receipt without observing or sending", async () => {
    const deps = dependencies();
    const result = await reconcilePayoutAttempt(context({
      attemptStatus: "confirmed",
      receiptStatus: "paid",
      confirmedAt: "2026-09-12T00:00:02.000Z",
      paidAt: "2026-09-12T00:00:02.000Z",
    }), deps);

    expect(result.kind).toBe("replay");
    expect(deps.observePayoutByHash).not.toHaveBeenCalled();
    expect(deps.confirmAtomic).not.toHaveBeenCalled();
    expect(deps).not.toHaveProperty("broadcast");
  });

  it("does not confirm non-final observations", async () => {
    const deps = dependencies({ observePayoutByHash: vi.fn(async () => found({ finality: "not_final" })) });
    const result = await reconcilePayoutAttempt(context(), deps);

    expect(result).toMatchObject({ kind: "reconciled", decision: { status: "pending" } });
    expect(deps.confirmAtomic).not.toHaveBeenCalled();
  });

  it("does not confirm a missing transaction", async () => {
    const deps = dependencies({ observePayoutByHash: vi.fn(async () => ({ kind: "not_found" as const })) });
    const result = await reconcilePayoutAttempt(context(), deps);

    expect(result).toMatchObject({ kind: "reconciled", decision: { reasonCode: "transaction_not_found_yet" } });
    expect(deps.confirmAtomic).not.toHaveBeenCalled();
  });

  it("does not confirm an RPC failure", async () => {
    const deps = dependencies({ observePayoutByHash: vi.fn(async () => ({ kind: "rpc_error" as const, code: "rpc_unavailable" as const })) });
    const result = await reconcilePayoutAttempt(context(), deps);

    expect(result).toMatchObject({ kind: "reconciled", decision: { status: "retryable" } });
    expect(deps.confirmAtomic).not.toHaveBeenCalled();
  });

  it("cannot confirm without a stored transaction hash", async () => {
    const deps = dependencies();
    const result = await reconcilePayoutAttempt(context({ transactionHash: null }), deps);

    expect(result).toEqual({ kind: "not_confirmable", reasonCode: "missing_transaction_hash" });
    expect(deps.observePayoutByHash).not.toHaveBeenCalled();
    expect(deps.confirmAtomic).not.toHaveBeenCalled();
  });

  it("cannot confirm an unstarted payout attempt", async () => {
    const deps = dependencies();
    const result = await reconcilePayoutAttempt(context({ broadcastStartedAt: null }), deps);

    expect(result).toEqual({ kind: "not_confirmable", reasonCode: "broadcast_not_started" });
    expect(deps.observePayoutByHash).not.toHaveBeenCalled();
  });

  it("does not fabricate a new transaction hash", async () => {
    const deps = dependencies({ observePayoutByHash: vi.fn(async () => ({ kind: "not_found" as const })) });
    const result = await reconcilePayoutAttempt(context(), deps);

    expect(result).toMatchObject({ kind: "reconciled", decision: { expectedTransactionHash: HASH, observedTransactionHash: null } });
    expect(result).not.toHaveProperty("transactionHash");
  });

  it("requires the atomic boundary to reject wrong attempt/receipt pairing", async () => {
    const deps = dependencies({
      confirmAtomic: vi.fn(async () => ({ kind: "error" as const, code: "attempt_receipt_mismatch" })),
    });
    const result = await reconcilePayoutAttempt(context({ receiptId: "wrong-receipt" }), deps);

    expect(result).toEqual({ kind: "error", reasonCode: "atomic_confirmation_failed" });
  });

  it("serializes concurrent reconciliation and performs one authoritative transition", async () => {
    let held = false;
    let confirmed = false;
    const deps = dependencies({
      acquireVaultLock: vi.fn(async () => {
        if (held) return false;
        held = true;
        return true;
      }),
      confirmAtomic: vi.fn(async () => {
        confirmed = true;
        return { kind: "confirmed" as const, data: {} };
      }),
      releaseVaultLock: vi.fn(async () => {
        held = false;
      }),
    });
    const results = await Promise.all([
      reconcilePayoutAttempt(context(), deps),
      reconcilePayoutAttempt(context(), deps),
    ]);

    expect(confirmed).toBe(true);
    expect(results.filter((result) => result.kind === "confirmed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "busy")).toHaveLength(1);
    expect(deps.confirmAtomic).toHaveBeenCalledTimes(1);
  });

  it("never imports or calls a payout broadcaster", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/rewards/payout-reconciliation.ts"), "utf8");
    expect(source).not.toMatch(/sendTransaction|broadcastTransaction|runRewardPayout/);
    expect(source).toContain('import "server-only"');
  });

  it("does not create refund rows or inspect poll outcomes", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/rewards/payout-reconciliation.ts"), "utf8");
    expect(source).not.toMatch(/reward_refunds|option_id|selectedOption|winner|majority/);
  });

  it("preserves V2B.2.7 no-blind-resend guards", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/rewards/payout.ts"), "utf8");
    expect(source).toContain("broadcastStartedAt");
    expect(source).toContain("preparedTransactionHex");
    expect(source).toContain("recordUnknownOutcome");
  });

  it("loads reconciliation authority by settlement ID without reading Poll/source lifecycle", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/rewards/payout-reconciliation.ts"), "utf8");
    const loaderStart = source.indexOf("export async function loadPayoutReconciliationContext");
    const loaderEnd = source.indexOf("function toPayoutExpected");
    const loaderSource = source.slice(loaderStart, loaderEnd);

    expect(loaderSource).toContain("settlementId");
    expect(loaderSource).toContain('.eq("id", settlementId)');
    expect(loaderSource).not.toContain('.from("polls")');
    expect(loaderSource).not.toContain("poll_id !==");
  });
});
