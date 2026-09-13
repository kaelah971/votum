import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadFundingConfirmationContext,
  reconcileFundingObservation,
  type FundingConfirmationContext,
} from "@/lib/rewards/funding-confirmation";
import type { FundingObservation } from "@/lib/rewards/reconciliation";

const HASH = "a".repeat(64);
const MICRO_HASH = "b".repeat(64);
const MACRO_HASH = "c".repeat(64);
const VAULT = "01" + "d".repeat(38);

const context: FundingConfirmationContext = {
  campaignId: "campaign-test-1",
  intentId: "intent-test-1",
  campaignStatus: "funding_pending",
  fundingStatus: "submitted",
  submittedTransactionHash: HASH,
  confirmedTransactionHash: null,
  reference: "votum:fund:campaign-test-1",
  networkId: 42,
  vaultAddress: VAULT,
  fundingVaultAddress: VAULT,
  requiredAmountLuna: BigInt(9000),
  fundingAmountLuna: BigInt(9000),
  fundedAmountLuna: BigInt(0),
  refundableExcessLuna: BigInt(0),
  fundedAt: null,
  confirmedAt: null,
};

function finalizedObservation(
  overrides: Partial<Extract<FundingObservation, { kind: "found" }>["transaction"]> = {},
): FundingObservation {
  return {
    kind: "found",
    transaction: {
      transactionHash: HASH,
      blockHash: null,
      networkId: 42,
      sender: "01" + "e".repeat(38),
      recipient: VAULT,
      valueLuna: BigInt(9000),
      memo: context.reference,
      executionResult: true,
      blockHeight: 100,
      timestampMs: 1_725_000_000_000,
      confirmationCount: 0,
      finality: "final",
      finalityReason: null,
      finalityEvidence: {
        transactionBlockHeight: 100,
        transactionBlockHash: null,
        canonicalBlockHash: MICRO_HASH,
        canonicalBlockVerified: true,
        batchNumber: 7,
        finalizingMacroBlockHeight: 105,
        finalizingMacroBlockHash: MACRO_HASH,
      },
      ...overrides,
    },
  };
}

describe("server reward funding confirmation boundary", () => {
  it("calls atomic confirmation only for a confirmed server reconciliation", async () => {
    const confirmAtomic = vi.fn().mockResolvedValue({
      kind: "confirmed",
      data: { result_kind: "confirmed" },
    });

    const result = await reconcileFundingObservation(
      context,
      finalizedObservation({ valueLuna: BigInt(10000) }),
      confirmAtomic,
    );

    expect(confirmAtomic).toHaveBeenCalledOnce();
    expect(confirmAtomic).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: context.campaignId,
      intentId: context.intentId,
      transactionHash: HASH,
      observedAmountLuna: BigInt(10000),
      blockNumber: 100,
    }));
    expect(result).toMatchObject({
      kind: "confirmed",
      decision: { status: "confirmed", confirmed: true },
    });
  });

  it.each([
    ["not_found", { kind: "not_found" }],
    ["rpc_error", { kind: "rpc_error", code: "rpc_unavailable" }],
    ["not_final", finalizedObservation({ finality: "not_final", finalityReason: "observed_not_final" })],
    ["wrong_recipient", finalizedObservation({ recipient: "01" + "f".repeat(38) })],
    ["wrong_network", finalizedObservation({ networkId: 43 })],
    ["execution_failure", finalizedObservation({ executionResult: false })],
    ["underpayment", finalizedObservation({ valueLuna: BigInt(8999) })],
  ])("does not call atomic confirmation for %s", async (_label, observation) => {
    const confirmAtomic = vi.fn();

    const result = await reconcileFundingObservation(
      context,
      observation as FundingObservation,
      confirmAtomic,
    );

    expect(confirmAtomic).not.toHaveBeenCalled();
    expect(result).not.toMatchObject({ kind: "confirmed" });
  });

  it("cannot confirm an unbound submitted intent", async () => {
    const confirmAtomic = vi.fn();
    const result = await reconcileFundingObservation(
      { ...context, submittedTransactionHash: null },
      finalizedObservation(),
      confirmAtomic,
    );

    expect(confirmAtomic).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "not_confirmable", reasonCode: "intent_unbound" });
  });

  it("does not trust a required amount supplied by an observation", async () => {
    const confirmAtomic = vi.fn().mockResolvedValue({
      kind: "confirmed",
      data: { result_kind: "confirmed" },
    });

    await reconcileFundingObservation(
      context,
      finalizedObservation({ valueLuna: BigInt(10000) }),
      confirmAtomic,
    );

    expect(confirmAtomic).toHaveBeenCalledWith(expect.objectContaining({
      requiredAmountLuna: context.requiredAmountLuna,
      observedAmountLuna: BigInt(10000),
    }));
  });
});

describe("funding confirmation route boundary", () => {
  it("does not accept browser-supplied confirmation or economic truth fields", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/app/api/polls/[pollId]/reward/funding/intents/[intentId]/confirm/route.ts",
      ),
      "utf8",
    );

    expect(source).not.toMatch(/body[\s\S]*confirmed|confirmed[\s\S]*body/);
    expect(source).not.toMatch(/body[\s\S]*amount|amount[\s\S]*body/);
    expect(source).not.toMatch(/body[\s\S]*vault|vault[\s\S]*body/);
    expect(source).toContain("createRewardSettlementService");
  });

  it("loads funding authority by settlement ID rather than a Poll lookup", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/rewards/funding-confirmation.ts"), "utf8");
    const loaderStart = source.indexOf("export async function loadFundingConfirmationContext");
    const loaderEnd = source.indexOf("export async function reconcileFundingObservation");
    const loaderSource = source.slice(loaderStart, loaderEnd);

    expect(loadFundingConfirmationContext).toBeTypeOf("function");
    expect(loaderSource).toContain("settlementId");
    expect(loaderSource).toContain('.eq("id", settlementId)');
    expect(loaderSource).not.toContain('.eq("poll_id",');
    expect(loaderSource).not.toContain('.from("polls")');
  });
});
