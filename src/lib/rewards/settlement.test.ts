import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createRewardSettlementService,
  loadRewardSettlementContext,
  resolvePollRewardSettlement,
  type RewardSettlementService,
} from "@/lib/rewards/settlement";

const POLL_ID = "poll-1";
const SETTLEMENT_ID = "settlement-1";
const INTENT_ID = "intent-1";
const RECEIPT_ID = "receipt-1";
const ATTEMPT_ID = "attempt-1";
const OWNER = "01" + "a".repeat(38);
const FUNDER = "02" + "b".repeat(38);
const VAULT = "03" + "c".repeat(38);

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  loadFunding: vi.fn(),
  fundingDependencies: vi.fn(),
  reconcileFunding: vi.fn(),
  executePayout: vi.fn(),
  loadPayout: vi.fn(),
  payoutDependencies: vi.fn(),
  reconcilePayout: vi.fn(),
}));

vi.mock("@/lib/rewards/funding-confirmation", () => ({
  createDefaultFundingConfirmationDependencies: mocks.fundingDependencies,
  loadFundingConfirmationContext: mocks.loadFunding,
  reconcileFundingIntent: mocks.reconcileFunding,
}));

vi.mock("@/lib/rewards/payout", () => ({
  executeReservedRewardPayout: mocks.executePayout,
}));

vi.mock("@/lib/rewards/payout-reconciliation", () => ({
  createDefaultPayoutReconciliationDependencies: mocks.payoutDependencies,
  loadPayoutReconciliationContext: mocks.loadPayout,
  reconcilePayoutAttempt: mocks.reconcilePayout,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

function adminFor(rows: {
  campaign?: Record<string, unknown> | null;
  vault?: Record<string, unknown> | null;
} = {}) {
  return {
    from(table: string) {
      let value = table === "reward_campaigns" ? rows.campaign : rows.vault;
      const query = {
        select: () => query,
        eq: (column: string, expected: string) => {
          if (
            (table === "reward_campaigns" && column === "id" && rows.campaign && rows.campaign.id !== expected) ||
            (table === "reward_campaign_vaults" && column === "campaign_id" && rows.vault && rows.vault.campaign_id !== expected)
          ) {
            value = null;
          }
          return query;
        },
        maybeSingle: async () => ({ data: value ?? null, error: null }),
      };
      return query;
    },
    rpc: mocks.rpc,
  };
}

function campaignRow(): Record<string, unknown> {
  return {
    id: SETTLEMENT_ID,
    creator_wallet: OWNER,
    funding_wallet: FUNDER,
    reward_per_participant_luna: 5000,
    reward_principal_luna: 15000,
    fee_reserve_luna: 1000,
    total_budget_luna: 16000,
    funded_amount_luna: 16000,
    paid_amount_luna: 5000,
    fee_spent_luna: 4000,
    refundable_excess_luna: 0,
    status: "rewarding",
    first_reservation_at: "2026-09-13T00:00:00.000Z",
  };
}

function successfulFundingRpc() {
  return {
    result_kind: "created",
    intent_id: INTENT_ID,
    campaign_id: SETTLEMENT_ID,
    reference: "votum:fund:settlement-1",
    vault_wallet: VAULT,
    reward_principal_luna: "15000",
    fee_reserve_luna: "1000",
    amount_luna: "16000",
    submitted_transaction_hash: null,
    confirmation_deadline: "2026-09-13T01:00:00.000Z",
    created_at: "2026-09-13T00:00:00.000Z",
  };
}

function makeService(): RewardSettlementService {
  mocks.fundingDependencies.mockReturnValue("funding-dependencies");
  mocks.payoutDependencies.mockReturnValue("payout-dependencies");
  mocks.loadFunding.mockResolvedValue({ kind: "ok", context: { campaignId: SETTLEMENT_ID } });
  mocks.reconcileFunding.mockResolvedValue({ kind: "confirmed" });
  mocks.loadPayout.mockResolvedValue({ kind: "ok", context: { campaignId: SETTLEMENT_ID } });
  mocks.reconcilePayout.mockResolvedValue({ kind: "confirmed" });
  mocks.executePayout.mockResolvedValue({ kind: "broadcasted", attemptId: ATTEMPT_ID, transactionHash: "a".repeat(64) });
  return createRewardSettlementService(adminFor() as never);
}

describe("RewardSettlementContext loader", () => {
  it("loads source-independent settlement identity, vault, economics, and lifecycle by settlement ID", async () => {
    vi.stubEnv("NIMIQ_NETWORK_ID", "42");
    const loaded = await loadRewardSettlementContext(adminFor({
      campaign: campaignRow(),
      vault: { campaign_id: SETTLEMENT_ID, vault_address_hex: VAULT },
    }) as never, SETTLEMENT_ID);

    expect(loaded).toEqual({
      kind: "ok",
      context: {
        settlementId: SETTLEMENT_ID,
        ownerWallet: OWNER,
        fundingWallet: FUNDER,
        vaultAddressHex: VAULT,
        networkId: 42,
        rewardPerParticipantLuna: BigInt(5000),
        rewardPrincipalLuna: BigInt(15000),
        feeReserveLuna: BigInt(1000),
        totalBudgetLuna: BigInt(16000),
        fundedAmountLuna: BigInt(16000),
        paidAmountLuna: BigInt(5000),
        feeSpentLuna: BigInt(4000),
        refundableExcessLuna: BigInt(0),
        state: "rewarding",
        firstReservationAt: "2026-09-13T00:00:00.000Z",
      },
    });
  });

  it("fails closed when the settlement or its vault is missing", async () => {
    await expect(loadRewardSettlementContext(adminFor() as never, SETTLEMENT_ID)).resolves.toMatchObject({
      kind: "not_found",
      reasonCode: "settlement_not_found",
    });
    await expect(loadRewardSettlementContext(adminFor({ campaign: campaignRow() }) as never, SETTLEMENT_ID)).resolves.toMatchObject({
      kind: "not_found",
      reasonCode: "vault_not_found",
    });
  });

  it("does not read Poll/source or accept client economics", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/rewards/settlement.ts"), "utf8");
    expect(source).not.toMatch(/optionId|selectedOption|allowlist|eventProof|campaignSecret/);
    expect(source).not.toMatch(/\.from\("polls"\)/);
  });
});

describe("Poll settlement resolver", () => {
  it("maps a Poll ID to reward_campaigns.id without making Poll ID the settlement identity", async () => {
    const loaded = await resolvePollRewardSettlement(adminFor({
      campaign: { id: SETTLEMENT_ID, poll_id: POLL_ID },
    }) as never, POLL_ID);

    expect(loaded).toEqual({ kind: "ok", settlementId: SETTLEMENT_ID });
  });

  it("fails closed when a Poll has no settlement binding", async () => {
    await expect(resolvePollRewardSettlement(adminFor() as never, POLL_ID)).resolves.toEqual({
      kind: "not_found",
      reasonCode: "settlement_not_found",
    });
  });
});

describe("RewardSettlementService", () => {
  it("delegates funding through the existing RPC with settlement terminology", async () => {
    mocks.rpc.mockResolvedValue({ data: successfulFundingRpc(), error: null });
    const service = makeService();

    const result = await service.beginFunding(SETTLEMENT_ID, FUNDER);

    expect(result).toMatchObject({ kind: "created", fundingIntent: { campaignId: SETTLEMENT_ID } });
    expect(mocks.rpc).toHaveBeenCalledWith("begin_reward_funding_atomic", {
      _campaign_id: SETTLEMENT_ID,
      _funder_wallet: FUNDER,
    });
    expect(JSON.stringify(result)).not.toMatch(/option|selected|clientReward|browser/i);
  });

  it("delegates funding binding and preserves safe result kinds", async () => {
    mocks.rpc.mockResolvedValue({
      data: { result_kind: "bound", campaign_id: SETTLEMENT_ID },
      error: null,
    });
    const service = makeService();

    await expect(service.bindFunding(SETTLEMENT_ID, INTENT_ID, FUNDER, "a".repeat(64))).resolves.toEqual({
      kind: "bound",
      settlementId: SETTLEMENT_ID,
      intentId: INTENT_ID,
      transactionHash: "a".repeat(64),
    });
    expect(mocks.rpc).toHaveBeenCalledWith("bind_reward_funding_transaction_atomic", {
      _campaign_id: SETTLEMENT_ID,
      _intent_id: INTENT_ID,
      _funder_wallet: FUNDER,
      _transaction_hash: "a".repeat(64),
    });
  });

  it("delegates confirmation through a settlement-ID loader and existing reconciliation", async () => {
    const service = makeService();

    await expect(service.confirmFunding(SETTLEMENT_ID, INTENT_ID, FUNDER)).resolves.toEqual({ kind: "confirmed" });
    expect(mocks.loadFunding).toHaveBeenCalledWith(expect.anything(), SETTLEMENT_ID, INTENT_ID, FUNDER);
    expect(mocks.reconcileFunding).toHaveBeenCalledWith({ campaignId: SETTLEMENT_ID }, "funding-dependencies");
  });

  it("delegates payout by settlement ID and preserves authoritative receipt inputs", async () => {
    const service = makeService();

    await expect(service.executePayout(SETTLEMENT_ID, RECEIPT_ID)).resolves.toMatchObject({ kind: "broadcasted" });
    expect(mocks.executePayout).toHaveBeenCalledWith(expect.anything(), RECEIPT_ID, SETTLEMENT_ID);
  });

  it("delegates payout reconciliation through a settlement-ID loader", async () => {
    const service = makeService();

    await expect(service.reconcilePayout(SETTLEMENT_ID, ATTEMPT_ID, OWNER)).resolves.toEqual({ kind: "confirmed" });
    expect(mocks.loadPayout).toHaveBeenCalledWith(expect.anything(), SETTLEMENT_ID, ATTEMPT_ID, OWNER);
    expect(mocks.reconcilePayout).toHaveBeenCalledWith({ campaignId: SETTLEMENT_ID }, "payout-dependencies");
  });

  it("does not allow an unrelated settlement result to become a successful financial result", async () => {
    mocks.rpc.mockResolvedValue({
      data: { ...successfulFundingRpc(), campaign_id: "other-settlement" },
      error: null,
    });
    const service = makeService();

    await expect(service.beginFunding(SETTLEMENT_ID, FUNDER)).resolves.toEqual({
      kind: "error",
      reasonCode: "settlement_mismatch",
    });
  });
});
