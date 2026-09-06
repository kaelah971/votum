import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Address } from "@nimiq/core";
import {
  reconcileRewardFunding,
  type ExpectedFunding,
  type FundingObservation,
  type ObservedFundingTransaction,
} from "@/lib/rewards/reconciliation";

const NETWORK_ID = 42;
const EXPECTED_HASH = "a".repeat(64);
const VAULT_HEX = "ab".repeat(20);
const OTHER_ADDRESS_HEX = "cd".repeat(20);
const SENDER_HEX = "ef".repeat(20);
const VAULT_NQ = Address.fromString(VAULT_HEX).toUserFriendlyAddress();
const OTHER_ADDRESS_NQ = Address.fromString(OTHER_ADDRESS_HEX).toUserFriendlyAddress();

const expectedFunding: ExpectedFunding = {
  campaignId: "campaign-test-1",
  fundingIntentId: "intent-test-1",
  networkId: NETWORK_ID,
  transactionHash: EXPECTED_HASH,
  vaultAddress: VAULT_HEX,
  amountLuna: BigInt(9000),
  memo: "votum-reward:campaign-test-1",
};

function observedTransaction(
  overrides: Partial<ObservedFundingTransaction> = {},
): ObservedFundingTransaction {
  return {
    transactionHash: EXPECTED_HASH,
    networkId: NETWORK_ID,
    sender: SENDER_HEX,
    recipient: VAULT_NQ,
    valueLuna: BigInt(9000),
    memo: expectedFunding.memo ?? null,
    executionResult: true,
    blockHeight: 12345,
    timestampMs: 1_725_000_000_000,
    confirmationCount: null,
    finality: "final",
    ...overrides,
  };
}

function found(
  overrides: Partial<ObservedFundingTransaction> = {},
): FundingObservation {
  return { kind: "found", transaction: observedTransaction(overrides) };
}

describe("reconcileRewardFunding", () => {
  it("keeps a transaction not found yet pending and never confirmed", () => {
    const result = reconcileRewardFunding(expectedFunding, { kind: "not_found" });

    expect(result.status).toBe("pending");
    expect(result.reasonCode).toBe("transaction_not_found_yet");
    expect(result.confirmed).toBe(false);
  });

  it("keeps RPC timeout and transport errors retryable and never confirmed", () => {
    const timeout = reconcileRewardFunding(expectedFunding, {
      kind: "rpc_error",
      code: "rpc_timeout",
    });
    const unavailable = reconcileRewardFunding(expectedFunding, {
      kind: "rpc_error",
      code: "rpc_unavailable",
    });

    expect(timeout).toMatchObject({ status: "retryable", reasonCode: "rpc_timeout", confirmed: false });
    expect(unavailable).toMatchObject({ status: "retryable", reasonCode: "rpc_unavailable", confirmed: false });
  });

  it("does not confirm an observed successful exact payment without finality", () => {
    const result = reconcileRewardFunding(
      expectedFunding,
      found({ finality: "not_final" }),
    );

    expect(result.status).toBe("pending");
    expect(result.reasonCode).toBe("observed_but_not_final");
    expect(result.confirmed).toBe(false);
  });

  it("confirms exact funding only after successful final observation", () => {
    const result = reconcileRewardFunding(expectedFunding, found());

    expect(result).toMatchObject({
      status: "confirmed",
      reasonCode: "confirmed_success",
      confirmed: true,
      amountComparison: "exact",
    });
    expect(result.excessAmountLuna).toBe(BigInt(0));
  });

  it("rejects a wrong recipient", () => {
    const result = reconcileRewardFunding(
      expectedFunding,
      found({ recipient: OTHER_ADDRESS_NQ }),
    );

    expect(result).toMatchObject({
      status: "rejected",
      reasonCode: "wrong_recipient",
      confirmed: false,
    });
  });

  it("rejects a wrong network", () => {
    const result = reconcileRewardFunding(
      expectedFunding,
      found({ networkId: NETWORK_ID + 1 }),
    );

    expect(result).toMatchObject({
      status: "rejected",
      reasonCode: "wrong_network",
      confirmed: false,
    });
  });

  it("rejects a hash mismatch", () => {
    const result = reconcileRewardFunding(
      expectedFunding,
      found({ transactionHash: "b".repeat(64) }),
    );

    expect(result).toMatchObject({
      status: "rejected",
      reasonCode: "hash_mismatch",
      confirmed: false,
    });
  });

  it("rejects underpayment without changing the expected terms", () => {
    const result = reconcileRewardFunding(
      expectedFunding,
      found({ valueLuna: BigInt(8999) }),
    );

    expect(result).toMatchObject({
      status: "rejected",
      reasonCode: "amount_underpaid",
      confirmed: false,
      amountComparison: "underpaid",
    });
    expect(result.expectedAmountLuna).toBe(BigInt(9000));
    expect(result.observedAmountLuna).toBe(BigInt(8999));
    expect(result.excessAmountLuna).toBe(BigInt(0));
  });

  it("confirms overpayment without changing terms and surfaces refundable excess", () => {
    const result = reconcileRewardFunding(
      expectedFunding,
      found({ valueLuna: BigInt(10000) }),
    );

    expect(result).toMatchObject({
      status: "confirmed",
      reasonCode: "amount_overpaid",
      confirmed: true,
      amountComparison: "overpaid",
    });
    expect(result.expectedAmountLuna).toBe(expectedFunding.amountLuna);
    expect(result.excessAmountLuna).toBe(BigInt(1000));
  });

  it("rejects explicit execution failure", () => {
    const result = reconcileRewardFunding(
      expectedFunding,
      found({ executionResult: false }),
    );

    expect(result).toMatchObject({
      status: "rejected",
      reasonCode: "execution_failed",
      confirmed: false,
    });
  });

  it("does not confirm when execution result is missing or unknown", () => {
    const result = reconcileRewardFunding(
      expectedFunding,
      found({ executionResult: null }),
    );

    expect(result).toMatchObject({
      status: "unknown",
      reasonCode: "execution_unknown",
      confirmed: false,
    });
  });

  it("fails safely on malformed observations", () => {
    const result = reconcileRewardFunding(expectedFunding, {
      kind: "malformed",
      reasonCode: "malformed_transaction",
    });

    expect(result).toMatchObject({
      status: "rejected",
      reasonCode: "malformed_transaction",
      confirmed: false,
    });
  });

  it("compares formatted and canonical Nimiq addresses through project primitives", () => {
    const result = reconcileRewardFunding(
      { ...expectedFunding, vaultAddress: VAULT_HEX },
      found({ recipient: VAULT_NQ }),
    );

    expect(result.confirmed).toBe(true);
  });

  it("makes final decisions idempotently for identical inputs", () => {
    const observation = found({ valueLuna: BigInt(10000) });
    const first = reconcileRewardFunding(expectedFunding, observation);
    const second = reconcileRewardFunding(expectedFunding, observation);

    expect(second).toEqual(first);
  });

  it("requires the expected memo when the funding architecture provides one", () => {
    const result = reconcileRewardFunding(
      expectedFunding,
      found({ memo: "votum-reward:another-campaign" }),
    );

    expect(result).toMatchObject({
      status: "rejected",
      reasonCode: "memo_mismatch",
      confirmed: false,
    });
  });
});

describe("funding reconciliation boundaries", () => {
  it("contains no selected poll option data", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/rewards/reconciliation.ts"),
      "utf8",
    );

    expect(source).not.toContain("option_id");
    expect(source).not.toContain("selectedOption");
  });
});
