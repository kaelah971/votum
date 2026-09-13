import { Address } from "@nimiq/core";
import { describe, expect, it } from "vitest";
import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import {
  auditCanonicalWalletRepresentation,
  loadRewardSettlementContext,
  resolvePollRewardSettlement,
  type HistoricalWalletIdentity,
} from "@/lib/rewards/settlement-root";

const POLL_ID = "11111111-1111-4111-8111-111111111111";
const SETTLEMENT_ID = "22222222-2222-4222-8222-222222222222";
const OWNER = "01" + "a".repeat(38);
const FUNDER = "02" + "b".repeat(38);

type Row = Record<string, unknown>;

function adminFor(tables: Record<string, Row[]> = {}) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        maybeSingle: async () => ({
          data: rows.length === 1 ? rows[0] : null,
          error: null,
        }),
      };
      return query;
    },
  };
}

function rootRow(): Row {
  return {
    id: SETTLEMENT_ID,
    owner_wallet: OWNER,
    funding_wallet: FUNDER,
    refund_recipient_wallet: OWNER,
    funding_mode: "community",
    asset: "NIM",
    reward_per_participant_luna: 5000,
    max_rewarded_participants: 3,
    reward_principal_luna: 15000,
    fee_reserve_luna: 1000,
    total_budget_luna: 16000,
    status: "rewarding",
    funded_amount_luna: 16000,
    refundable_excess_luna: 0,
    rewarded_participant_count: 1,
    paid_amount_luna: 5000,
    fee_spent_luna: 4000,
    refundable_amount_luna: 7000,
    first_reservation_at: "2026-09-13T00:00:00.000Z",
    payout_lock_attempt_id: null,
    payout_lock_expires_at: null,
    payout_lock_token: null,
    created_at: "2026-09-12T00:00:00.000Z",
    funded_at: "2026-09-12T01:00:00.000Z",
    closed_at: null,
    refunded_at: null,
    updated_at: "2026-09-13T00:00:00.000Z",
  };
}

function pollRows(): Record<string, Row[]> {
  return {
    polls: [{ id: POLL_ID, creator_wallet: OWNER }],
    reward_campaigns: [{
      id: SETTLEMENT_ID,
      poll_id: POLL_ID,
      settlement_id: SETTLEMENT_ID,
      creator_wallet: OWNER,
    }],
    settlement_source_bindings: [{
      settlement_id: SETTLEMENT_ID,
      source_type: "poll_reward_campaign",
      reward_campaign_id: SETTLEMENT_ID,
    }],
    reward_settlements: [rootRow()],
  };
}

describe("V2C.2A canonical wallet preflight", () => {
  it("records the repository's lowercase 40-hex canonical representation", () => {
    const nq = Address.fromString(OWNER).toUserFriendlyAddress();
    expect(normalizeAddress(nq)).toBe(OWNER);

    const report = auditCanonicalWalletRepresentation([
      {
        sourceTable: "polls",
        sourceId: POLL_ID,
        column: "creator_wallet",
        value: OWNER,
      },
      {
        sourceTable: "reward_campaigns",
        sourceId: SETTLEMENT_ID,
        column: "creator_wallet",
        value: nq,
      },
    ]);

    expect(report.canProceed).toBe(true);
    expect(report.invalid).toEqual([]);
    expect(report.collisions).toEqual([]);
    expect(report.entries).toEqual([
      expect.objectContaining({
        sourceTable: "polls",
        sourceId: POLL_ID,
        column: "creator_wallet",
        classification: "canonical_hex",
        canonicalValue: OWNER,
      }),
      expect.objectContaining({
        sourceTable: "reward_campaigns",
        sourceId: SETTLEMENT_ID,
        column: "creator_wallet",
        classification: "alternate_valid_nimiq",
        canonicalValue: OWNER,
      }),
    ]);
  });

  it("fails closed for malformed historical identity and reports its row", () => {
    const identity: HistoricalWalletIdentity = {
      sourceTable: "reward_campaigns",
      sourceId: SETTLEMENT_ID,
      column: "funding_wallet",
      value: "not-an-address",
    };

    const report = auditCanonicalWalletRepresentation([identity]);

    expect(report.canProceed).toBe(false);
    expect(report.invalid).toEqual([
      expect.objectContaining({
        sourceTable: "reward_campaigns",
        sourceId: SETTLEMENT_ID,
        column: "funding_wallet",
        classification: "invalid",
        canonicalValue: null,
      }),
    ]);
  });

  it("fails closed for a normalization collision inside a declared unique scope", () => {
    const report = auditCanonicalWalletRepresentation([
      {
        sourceTable: "wallet_sessions",
        sourceId: "session-a",
        column: "wallet_address",
        value: OWNER,
        uniquenessScope: "wallet-session-identity",
      },
      {
        sourceTable: "wallet_sessions",
        sourceId: "session-b",
        column: "wallet_address",
        value: OWNER,
        uniquenessScope: "wallet-session-identity",
      },
    ]);

    expect(report.canProceed).toBe(false);
    expect(report.collisions).toEqual([
      expect.objectContaining({
        uniquenessScope: "wallet-session-identity",
        canonicalValue: OWNER,
        sourceIds: ["session-a", "session-b"],
      }),
    ]);
  });
});

describe("V2C.2A generic settlement root loader", () => {
  it("loads the root snapshot without reading a Poll or vault row", async () => {
    const loaded = await loadRewardSettlementContext(
      adminFor({ reward_settlements: [rootRow()] }) as never,
      SETTLEMENT_ID,
    );

    expect(loaded).toEqual({
      kind: "ok",
      root: {
        settlementId: SETTLEMENT_ID,
        ownerWallet: OWNER,
        fundingWallet: FUNDER,
        refundRecipientWallet: OWNER,
        fundingMode: "community",
        asset: "NIM",
        rewardPerParticipantLuna: BigInt(5000),
        maxRewardedParticipants: 3,
        rewardPrincipalLuna: BigInt(15000),
        feeReserveLuna: BigInt(1000),
        totalBudgetLuna: BigInt(16000),
        status: "rewarding",
        fundedAmountLuna: BigInt(16000),
        refundableExcessLuna: BigInt(0),
        rewardedParticipantCount: 1,
        paidAmountLuna: BigInt(5000),
        feeSpentLuna: BigInt(4000),
        refundableAmountLuna: BigInt(7000),
        firstReservationAt: "2026-09-13T00:00:00.000Z",
        payoutLockAttemptId: null,
        payoutLockExpiresAt: null,
        payoutLockToken: null,
        createdAt: "2026-09-12T00:00:00.000Z",
        fundedAt: "2026-09-12T01:00:00.000Z",
        closedAt: null,
        refundedAt: null,
        updatedAt: "2026-09-13T00:00:00.000Z",
      },
    });
  });

  it("fails closed for missing or malformed roots", async () => {
    await expect(
      loadRewardSettlementContext(adminFor() as never, SETTLEMENT_ID),
    ).resolves.toEqual({
      kind: "not_found",
      reasonCode: "settlement_not_found",
    });

    await expect(
      loadRewardSettlementContext(adminFor({
        reward_settlements: [{ ...rootRow(), owner_wallet: "bad" }],
      }) as never, SETTLEMENT_ID),
    ).resolves.toEqual({
      kind: "error",
      reasonCode: "malformed_settlement_root",
    });
  });
});

describe("V2C.2A Poll settlement resolver", () => {
  it("proves Poll -> reward campaign -> binding -> settlement", async () => {
    const resolved = await resolvePollRewardSettlement(
      adminFor(pollRows()) as never,
      POLL_ID,
    );

    expect(resolved).toEqual({
      kind: "ok",
      settlementId: SETTLEMENT_ID,
      rewardCampaignId: SETTLEMENT_ID,
      pollId: POLL_ID,
      sourceType: "poll_reward_campaign",
      ownerWallet: OWNER,
    });
  });

  it("fails closed when the binding or owner relationship is broken", async () => {
    const rows = pollRows();
    rows.settlement_source_bindings[0].source_type = "wrong_source";
    await expect(
      resolvePollRewardSettlement(adminFor(rows) as never, POLL_ID),
    ).resolves.toEqual({
      kind: "error",
      reasonCode: "malformed_settlement_binding",
    });

    const ownerMismatch = pollRows();
    ownerMismatch.polls[0].creator_wallet = FUNDER;
    await expect(
      resolvePollRewardSettlement(adminFor(ownerMismatch) as never, POLL_ID),
    ).resolves.toEqual({
      kind: "error",
      reasonCode: "malformed_settlement_binding",
    });
  });
});
