import { describe, expect, it } from "vitest";
import {
  deriveClaimState,
  getOwnCampaignClaim,
  getPublicCampaignGiveaway,
  type ClaimStateInput,
} from "@/lib/campaigns/public-giveaway";

const NOW = Date.parse("2026-09-16T12:00:00.000Z");
const OWNER = "01" + "a".repeat(38);
const SETTLEMENT = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "22222222-2222-4222-8222-222222222222";

function input(overrides: Partial<ClaimStateInput> = {}): ClaimStateInput {
  return {
    campaignStatus: "published",
    settlementStatus: "funded",
    startsAt: null,
    endsAt: null,
    remainingRewards: 5,
    fundingReady: true,
    now: NOW,
    ...overrides,
  };
}

describe("deriveClaimState", () => {
  it("reports unpublished for drafts", () => {
    expect(deriveClaimState(input({ campaignStatus: "draft" }))).toBe("unpublished");
  });

  it("reports needs_funding for published but unfunded Campaigns", () => {
    expect(
      deriveClaimState(input({ settlementStatus: "configured", fundingReady: false })),
    ).toBe("needs_funding");
    expect(
      deriveClaimState(input({ settlementStatus: "funding_pending", fundingReady: false })),
    ).toBe("needs_funding");
  });

  it("reports starts_soon before starts_at without any flag flip", () => {
    expect(
      deriveClaimState(input({ startsAt: "2026-09-17T12:00:00.000Z" })),
    ).toBe("starts_soon");
    expect(
      deriveClaimState(input({ startsAt: "2026-09-16T12:00:00.000Z" })),
    ).toBe("open");
  });

  it("reports open for published, funded, active Campaigns with capacity", () => {
    expect(deriveClaimState(input())).toBe("open");
    expect(deriveClaimState(input({ settlementStatus: "rewarding" }))).toBe("open");
  });

  it("reports full when no rewards remain", () => {
    expect(
      deriveClaimState(input({ settlementStatus: "exhausted", remainingRewards: 0 })),
    ).toBe("full");
  });

  it("reports ended for elapsed windows and expired product state", () => {
    expect(
      deriveClaimState(input({ endsAt: "2026-09-15T12:00:00.000Z" })),
    ).toBe("ended");
    expect(deriveClaimState(input({ campaignStatus: "expired" }))).toBe("ended");
  });

  it("reports closed for manual closure, cancellation, and financial freeze", () => {
    expect(deriveClaimState(input({ campaignStatus: "closed" }))).toBe("closed");
    expect(deriveClaimState(input({ campaignStatus: "cancelled" }))).toBe("closed");
    expect(
      deriveClaimState(input({ settlementStatus: "closed", fundingReady: false })),
    ).toBe("closed");
  });
});

type Row = Record<string, unknown>;

function settlementRow(overrides: Row = {}): Row {
  return {
    id: SETTLEMENT,
    owner_wallet: OWNER,
    funding_wallet: OWNER,
    refund_recipient_wallet: OWNER,
    funding_mode: "creator",
    asset: "NIM",
    reward_per_participant_luna: 50000,
    max_rewarded_participants: 10,
    reward_principal_luna: 500000,
    fee_reserve_luna: 80000,
    total_budget_luna: 580000,
    status: "funded",
    funded_amount_luna: 580000,
    refundable_excess_luna: 0,
    rewarded_participant_count: 0,
    paid_amount_luna: 0,
    fee_spent_luna: 0,
    refundable_amount_luna: 0,
    first_reservation_at: null,
    payout_lock_attempt_id: null,
    payout_lock_expires_at: null,
    payout_lock_token: null,
    created_at: "2026-09-16T10:00:00.000Z",
    funded_at: "2026-09-16T11:00:00.000Z",
    closed_at: null,
    refunded_at: null,
    updated_at: "2026-09-16T11:00:00.000Z",
    ...overrides,
  };
}

function campaignRow(overrides: Row = {}): Row {
  return {
    id: CAMPAIGN,
    campaign_type: "public_giveaway",
    visibility: "public",
    title: "Neighborhood cleanup reward",
    description: "Join the Saturday cleanup.",
    status: "published",
    starts_at: null,
    ends_at: null,
    settlement_id: SETTLEMENT,
    owner_wallet: OWNER,
    ...overrides,
  };
}

function bindingRow(): Row {
  return {
    settlement_id: SETTLEMENT,
    source_type: "participation_campaign",
    participation_campaign_id: CAMPAIGN,
    reward_campaign_id: null,
  };
}

function makeAdmin(tables: Record<string, Row[]>) {
  const chain = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let head = false;
    const api: Record<string, unknown> = {
      select: (_columns?: string, options?: { count?: string; head?: boolean }) => {
        head = options?.head === true;
        return api;
      },
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return api;
      },
      order: () => api,
      limit: () => api,
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        (api.maybeSingle as () => Promise<unknown>)().then(resolve, reject),
      maybeSingle: async () => {
        const rows = (tables[table] ?? []).filter((row) =>
          filters.every(([col, val]) => row[col] === val),
        );
        return head
          ? { data: null, count: rows.length, error: null }
          : { data: rows[0] ?? null, error: null };
      },
    };
    return api;
  };
  return { from: (table: string) => chain(table) };
}

function baseTables(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    participation_campaigns: [campaignRow()],
    settlement_source_bindings: [bindingRow()],
    reward_settlements: [settlementRow()],
    reward_receipts: [],
    reward_payout_attempts: [],
    ...extra,
  };
}

describe("getPublicCampaignGiveaway", () => {
  it("projects the exact allowlisted DTO for an open Campaign", async () => {
    const dto = await getPublicCampaignGiveaway(makeAdmin(baseTables()) as never, CAMPAIGN);
    expect(dto).toEqual({
      campaignId: CAMPAIGN,
      campaignType: "public_giveaway",
      visibility: "public",
      title: "Neighborhood cleanup reward",
      description: "Join the Saturday cleanup.",
      startsAt: null,
      endsAt: null,
      claimState: "open",
      published: true,
      fundingReady: true,
      rewardPerParticipantNim: "0.5 NIM",
      maxRewardedParticipants: 10,
      remainingRewards: 10,
      reservedCount: 0,
      paidCount: 0,
    });
    const serialized = JSON.stringify(dto);
    for (const forbidden of [
      "participant_wallet",
      "nonce",
      "ciphertext",
      "private",
      "token",
      "lease",
      "prepared",
      "refund",
      "vault",
      "owner",
      "challenge",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("returns null for unknown, draft, private, cancelled, and non-giveaway Campaigns", async () => {
    const admin = makeAdmin(baseTables()) as never;
    await expect(getPublicCampaignGiveaway(admin, "missing")).resolves.toBeNull();

    const draftTables = {
      ...baseTables(),
      participation_campaigns: [campaignRow({ status: "draft" })],
    };
    await expect(
      getPublicCampaignGiveaway(makeAdmin(draftTables) as never, CAMPAIGN),
    ).resolves.toBeNull();

    const privateTables = {
      ...baseTables(),
      participation_campaigns: [campaignRow({ visibility: "private" })],
    };
    await expect(
      getPublicCampaignGiveaway(makeAdmin(privateTables) as never, CAMPAIGN),
    ).resolves.toBeNull();

    const cancelledTables = {
      ...baseTables(),
      participation_campaigns: [campaignRow({ status: "cancelled" })],
    };
    await expect(
      getPublicCampaignGiveaway(makeAdmin(cancelledTables) as never, CAMPAIGN),
    ).resolves.toBeNull();

    const secretTables = {
      ...baseTables(),
      participation_campaigns: [campaignRow({ campaign_type: "secret_drop" })],
    };
    await expect(
      getPublicCampaignGiveaway(makeAdmin(secretTables) as never, CAMPAIGN),
    ).resolves.toBeNull();
  });

  it("keeps published-but-unfunded Campaigns visible with needs_funding", async () => {
    const tables = {
      ...baseTables(),
      reward_settlements: [settlementRow({ status: "configured", funded_amount_luna: 0, funded_at: null })],
    };
    const dto = await getPublicCampaignGiveaway(makeAdmin(tables) as never, CAMPAIGN);
    expect(dto).toMatchObject({ claimState: "needs_funding", published: true, fundingReady: false });
  });
});

describe("getOwnCampaignClaim before entitlements exist", () => {
  it("returns not-claimed without distinguishing empty from foreign claims", async () => {
    const admin = makeAdmin(baseTables()) as never;
    await expect(getOwnCampaignClaim(admin, CAMPAIGN, OWNER)).resolves.toEqual({ claimed: false });
    await expect(
      getOwnCampaignClaim(admin, CAMPAIGN, "01" + "f".repeat(38)),
    ).resolves.toEqual({ claimed: false });
  });

  it("returns null for unresolvable Campaigns", async () => {
    const admin = makeAdmin(baseTables()) as never;
    await expect(getOwnCampaignClaim(admin, "missing", OWNER)).resolves.toBeNull();
  });
});
