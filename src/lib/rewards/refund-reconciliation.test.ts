import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  reconcileRefund,
  type RefundReconciliationContext,
  type RefundReconciliationDependencies,
} from "@/lib/rewards/refund-reconciliation";
import type {
  ExpectedRefund,
  FundingObservation,
  ObservedFundingTransaction,
} from "@/lib/rewards/reconciliation";
import { reconcileRewardRefund } from "@/lib/rewards/reconciliation";

const CAMPAIGN_ID = "campaign-refund-test";
const REFUND_ID = "refund-refund-test";
const NETWORK_ID = 42;
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const VAULT_HEX = "ab".repeat(20);
const CREATOR_HEX = "cd".repeat(20);
const OTHER_HEX = "ef".repeat(20);

const expectedRefund: ExpectedRefund = {
  campaignId: CAMPAIGN_ID,
  refundId: REFUND_ID,
  networkId: NETWORK_ID,
  transactionHash: HASH,
  vaultAddress: VAULT_HEX,
  creatorWallet: CREATOR_HEX,
  amountLuna: BigInt(11200),
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
    recipient: CREATOR_HEX,
    valueLuna: BigInt(11200),
    memo: null,
    executionResult: true,
    blockHeight: 100,
    timestampMs: 1_725_000_000_000,
    confirmationCount: 0,
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
  overrides: Partial<RefundReconciliationContext> = {},
): RefundReconciliationContext {
  return {
    refundId: REFUND_ID,
    campaignId: CAMPAIGN_ID,
    campaignStatus: "refunding",
    refundStatus: "pending",
    creatorWallet: CREATOR_HEX,
    amountLuna: BigInt(11200),
    vaultAddress: VAULT_HEX,
    networkId: NETWORK_ID,
    transactionHash: HASH,
    broadcastStartedAt: "2026-09-12T00:00:00.000Z",
    broadcastAt: "2026-09-12T00:00:01.000Z",
    confirmedAt: null,
    refundedAt: null,
    closedAt: null,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<RefundReconciliationDependencies> = {},
): RefundReconciliationDependencies {
  return {
    observeRefundByHash: vi.fn(async () => found()),
    confirmAtomic: vi.fn(async () => ({ kind: "confirmed" as const, data: {} })),
    createLockToken: () => "lock-token",
    acquireVaultLock: vi.fn(async () => true),
    releaseVaultLock: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("reconcileRewardRefund", () => {
  it("confirms an exact finalized refund", () => {
    expect(reconcileRewardRefund(expectedRefund, found())).toMatchObject({
      status: "confirmed",
      reasonCode: "confirmed_success",
      confirmed: true,
      amountComparison: "exact",
    });
  });

  it("keeps a non-final refund pending", () => {
    expect(reconcileRewardRefund(expectedRefund, found({
      finality: "not_final",
      finalityReason: "observed_not_final",
    }))).toMatchObject({ status: "pending", confirmed: false });
  });

  it("rejects a missing stored hash before observation", async () => {
    const deps = dependencies();
    const result = await reconcileRefund(context({ transactionHash: null }), deps);
    expect(result).toEqual({ kind: "not_confirmable", reasonCode: "missing_transaction_hash" });
    expect(deps.observeRefundByHash).not.toHaveBeenCalled();
  });

  it("rejects a wrong transaction hash", () => {
    expect(reconcileRewardRefund(expectedRefund, found({ transactionHash: OTHER_HASH }))).toMatchObject({
      status: "rejected",
      reasonCode: "hash_mismatch",
    });
  });

  it("rejects the wrong network", () => {
    expect(reconcileRewardRefund(expectedRefund, found({ networkId: NETWORK_ID + 1 }))).toMatchObject({
      status: "rejected",
      reasonCode: "wrong_network",
    });
  });

  it("rejects the wrong sender", () => {
    expect(reconcileRewardRefund(expectedRefund, found({ sender: OTHER_HEX }))).toMatchObject({
      status: "rejected",
      reasonCode: "wrong_sender",
    });
  });

  it("rejects the wrong recipient", () => {
    expect(reconcileRewardRefund(expectedRefund, found({ recipient: OTHER_HEX }))).toMatchObject({
      status: "rejected",
      reasonCode: "wrong_recipient",
    });
  });

  it.each([
    [BigInt(11199), "amount_underpaid"],
    [BigInt(11201), "amount_overpaid"],
  ])("rejects refund amount %s", (amount, reasonCode) => {
    expect(reconcileRewardRefund(expectedRefund, found({ valueLuna: amount }))).toMatchObject({
      status: "rejected",
      reasonCode,
    });
  });

  it("rejects a failed execution", () => {
    expect(reconcileRewardRefund(expectedRefund, found({ executionResult: false }))).toMatchObject({
      status: "rejected",
      reasonCode: "execution_failed",
    });
  });

  it("does not confirm an unknown execution result", () => {
    expect(reconcileRewardRefund(expectedRefund, found({ executionResult: null }))).toMatchObject({
      status: "unknown",
      reasonCode: "execution_unknown",
    });
  });

  it("keeps a not-found transaction pending", () => {
    expect(reconcileRewardRefund(expectedRefund, { kind: "not_found" })).toMatchObject({
      status: "pending",
      reasonCode: "transaction_not_found_yet",
    });
  });

  it("keeps an observation RPC failure retryable", () => {
    expect(reconcileRewardRefund(expectedRefund, { kind: "rpc_error", code: "rpc_timeout" })).toMatchObject({
      status: "retryable",
      reasonCode: "rpc_timeout",
    });
  });

  it("keeps a canonical block mismatch pending", () => {
    expect(reconcileRewardRefund(expectedRefund, found({
      finality: "not_final",
      finalityReason: "canonical_block_mismatch",
    }))).toMatchObject({ status: "pending", reasonCode: "canonical_block_mismatch" });
  });

  it("does not confirm without finality evidence", () => {
    expect(reconcileRewardRefund(expectedRefund, found({ finalityEvidence: null }))).toMatchObject({
      status: "pending",
      reasonCode: "finality_unknown",
      confirmed: false,
    });
  });

  it("does not treat confirmation counts as finality", () => {
    expect(reconcileRewardRefund(expectedRefund, found({
      finality: "final",
      finalityEvidence: null,
      confirmationCount: 999,
    }))).toMatchObject({ status: "pending", confirmed: false });
  });

  it("rejects malformed observations", () => {
    expect(reconcileRewardRefund(expectedRefund, { kind: "malformed", reasonCode: "malformed_transaction" })).toMatchObject({
      status: "rejected",
      reasonCode: "malformed_transaction",
    });
  });
});

describe("server refund reconciliation boundary", () => {
  it("passes exact observed sender, recipient, amount, and finality proof to the atomic boundary", async () => {
    const deps = dependencies();
    const result = await reconcileRefund(context(), deps);

    expect(result.kind).toBe("confirmed");
    expect(deps.confirmAtomic).toHaveBeenCalledWith(expect.objectContaining({
      refundId: REFUND_ID,
      campaignId: CAMPAIGN_ID,
      transactionHash: HASH,
      observedSender: VAULT_HEX,
      observedRecipient: CREATOR_HEX,
      observedAmountLuna: BigInt(11200),
      networkId: NETWORK_ID,
      blockNumber: 100,
      batchNumber: 7,
      finalizingMacroBlockHeight: 105,
    }));
  });

  it("does not confirm a non-final observation", async () => {
    const deps = dependencies({ observeRefundByHash: vi.fn(async () => found({ finality: "not_final" })) });
    const result = await reconcileRefund(context(), deps);
    expect(result).toMatchObject({ kind: "reconciled", decision: { status: "pending" } });
    expect(deps.confirmAtomic).not.toHaveBeenCalled();
  });

  it("does not confirm an RPC or missing-transaction observation", async () => {
    const rpcDeps = dependencies({ observeRefundByHash: vi.fn(async () => ({ kind: "rpc_error" as const, code: "rpc_unavailable" as const })) });
    const notFoundDeps = dependencies({ observeRefundByHash: vi.fn(async () => ({ kind: "not_found" as const })) });
    expect((await reconcileRefund(context(), rpcDeps)).kind).toBe("reconciled");
    expect((await reconcileRefund(context(), notFoundDeps)).kind).toBe("reconciled");
    expect(rpcDeps.confirmAtomic).not.toHaveBeenCalled();
    expect(notFoundDeps.confirmAtomic).not.toHaveBeenCalled();
  });

  it("does not confirm before broadcast started", async () => {
    const deps = dependencies();
    const result = await reconcileRefund(context({ broadcastStartedAt: null }), deps);
    expect(result).toEqual({ kind: "not_confirmable", reasonCode: "broadcast_not_started" });
    expect(deps.observeRefundByHash).not.toHaveBeenCalled();
  });

  it("returns a replay without observing an already refunded campaign", async () => {
    const deps = dependencies();
    const result = await reconcileRefund(context({
      campaignStatus: "refunded",
      refundStatus: "confirmed",
      confirmedAt: "2026-09-12T00:00:02.000Z",
      refundedAt: "2026-09-12T00:00:02.000Z",
    }), deps);
    expect(result.kind).toBe("replay");
    expect(deps.observeRefundByHash).not.toHaveBeenCalled();
    expect(deps.confirmAtomic).not.toHaveBeenCalled();
  });

  it("returns an error when the atomic boundary rejects the exact proof", async () => {
    const deps = dependencies({
      confirmAtomic: vi.fn(async () => ({ kind: "error" as const, code: "refund_state_conflict" })),
    });
    expect(await reconcileRefund(context(), deps)).toEqual({
      kind: "error",
      reasonCode: "atomic_confirmation_failed",
    });
  });

  it("serializes concurrent confirmation through the vault lease", async () => {
    let held = false;
    const confirmAtomic = vi.fn(async () => ({ kind: "confirmed" as const, data: {} }));
    const deps = dependencies({
      acquireVaultLock: vi.fn(async () => {
        if (held) return false;
        held = true;
        return true;
      }),
      confirmAtomic,
      releaseVaultLock: vi.fn(async () => { held = false; }),
    });
    const results = await Promise.all([
      reconcileRefund(context(), deps),
      reconcileRefund(context(), deps),
    ]);
    expect(results.filter((result) => result.kind === "confirmed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "busy")).toHaveLength(1);
    expect(confirmAtomic).toHaveBeenCalledTimes(1);
  });

  it("never imports or calls a refund broadcaster or vault signer", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/rewards/refund-reconciliation.ts"), "utf8");
    expect(source).not.toMatch(/sendTransaction|broadcastTransaction|executeRewardRefund|withCampaignVaultKey|signReward/);
    expect(source).toContain('import "server-only"');
  });

  it("does not inspect poll outcomes or implement V2C product paths", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/rewards/refund-reconciliation.ts"), "utf8");
    expect(source).not.toMatch(/option_id|selectedOption|winner|majority|Secret Drop|Private Drop|Event Drop|Community Reward/);
  });
});
