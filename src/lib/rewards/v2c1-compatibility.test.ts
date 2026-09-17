import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { mapPollRow, mapPublicRewardCampaign } from "@/lib/data/public-polls";
import {
  createPollRewardParticipationAdapter,
  type PollRewardParticipationStore,
} from "@/lib/rewards/poll-participation-adapter";
import { parseRewardParticipationContext } from "@/lib/rewards/participation";
import type { Database } from "@/types/database";

type PollRow = Database["public"]["Tables"]["polls"]["Row"];

const ROOT = process.cwd();
const PARTICIPANT = "01" + "a".repeat(38);
const OWNER = "02" + "b".repeat(38);

function source(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

function row(overrides: Partial<PollRow>): PollRow {
  return {
    id: "poll-1",
    question: "Which option should ship next?",
    description: "A decision context",
    mode: null,
    destination_wallet: null,
    destination_purpose: null,
    min_nim_luna: null,
    fairness_mode: "one_wallet_one_vote",
    status: "live",
    starts_at: null,
    ends_at: "2026-09-14T00:00:00.000Z",
    is_public: true,
    created_at: "2026-09-13T00:00:00.000Z",
    updated_at: "2026-09-13T00:00:00.000Z",
    published_at: "2026-09-13T00:00:00.000Z",
    category: "communities",
    format: "decision",
    economic_model: "reward_first",
    reward_mode: "free",
    creator_wallet: OWNER,
    ...overrides,
  };
}

const options = [
  { id: "option-a", poll_id: "poll-1", label: "A", sort_order: 0, created_at: "2026-09-13T00:00:00.000Z" },
  { id: "option-b", poll_id: "poll-1", label: "B", sort_order: 1, created_at: "2026-09-13T00:00:00.000Z" },
];

function adapterFor(overrides: {
  economicModel?: string | null;
  rewardMode?: string | null;
  participantWallet?: string;
} = {}) {
  const store: PollRewardParticipationStore = {
    loadVote: vi.fn(async () => ({
      id: "vote-1",
      pollId: "poll-1",
      participantWallet: overrides.participantWallet ?? PARTICIPANT,
      committed: true,
    })),
    loadPoll: vi.fn(async () => ({
      id: "poll-1",
      creatorWallet: OWNER,
      economicModel: overrides.economicModel ?? "reward_first",
      rewardMode: overrides.rewardMode ?? "rewarded",
      isPublic: true,
      status: "live",
    })),
    loadSettlementBinding: vi.fn(async () => ({ settlementId: "settlement-1", pollId: "poll-1" })),
  };

  return {
    store,
    adapter: createPollRewardParticipationAdapter(store),
  };
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("V2C.1E Poll compatibility gate", () => {
  it("keeps legacy, free, and rewarded Poll serializers distinct", () => {
    const legacy = mapPollRow(row({
      mode: "creator_support",
      destination_wallet: OWNER,
      destination_purpose: "Historical support",
      min_nim_luna: 1000,
      economic_model: "legacy_support",
      reward_mode: null,
    }), options);
    const free = mapPollRow(row({}), options);
    const rewarded = mapPollRow(row({ reward_mode: "rewarded" }), options, {
      pollId: "poll-1",
      campaignId: "settlement-1",
      status: "funded",
      rewardPerParticipantLuna: "5000",
      maxRewardedParticipants: 10,
      rewardPrincipalLuna: "50000",
      rewardsRemaining: 10,
      funded: true,
    });

    expect(legacy).toMatchObject({ economicModel: "legacy_support", rewardMode: null, minimumNim: 0.01 });
    expect(free).toMatchObject({ economicModel: "reward_first", rewardMode: "free" });
    expect(free).not.toHaveProperty("rewardCampaign");
    expect(rewarded).toMatchObject({ economicModel: "reward_first", rewardMode: "rewarded", rewardCampaign: { campaignId: "settlement-1" } });
    expect(mapPublicRewardCampaign({ result_kind: "found", funded: false })).toBeUndefined();
  });

  it("keeps the Poll vote path automatic, best-effort, and claim-free", () => {
    const voteRoute = source("src/app/api/polls/[pollId]/vote/route.ts");
    const voteTests = source("src/app/api/polls/[pollId]/vote/route.test.ts");
    const pollApiFiles = filesUnder(resolve(ROOT, "src/app/api/polls"));
    const pollComponentFiles = filesUnder(resolve(ROOT, "src/components/poll"));

    expect(voteRoute).toContain('"cast_poll_vote_atomic"');
    expect(voteRoute).toContain("await reserveRewardAfterVote");
    expect(voteRoute).toContain("await settlementService.executePayout");
    expect(voteTests).toContain("keeps a valid vote when reservation fails");
    expect(voteTests).toContain("automatically pays only a reserved or replayed receipt");
    expect(pollApiFiles.some((file) => /claim/i.test(file))).toBe(false);
    expect(pollComponentFiles.map((file) => readFileSync(file, "utf8")).join("\n"))
      .not.toMatch(/\bClaim\b|claimReward|\/claim/);
  });

  it("keeps Poll reward eligibility source-specific and fail-closed", async () => {
    for (const mode of [
      { economicModel: "legacy_support", rewardMode: null },
      { economicModel: "reward_first", rewardMode: "free" },
    ]) {
      const { adapter, store } = adapterFor(mode);
      await expect(adapter.resolveParticipation({
        pollId: "poll-1",
        participationId: "vote-1",
        verifiedSession: { address: PARTICIPANT },
      })).resolves.toMatchObject({ kind: "ineligible", reasonCode: "poll_not_rewarded" });
      expect(store.loadSettlementBinding).not.toHaveBeenCalled();
    }

    const creator = adapterFor({ participantWallet: OWNER });
    await expect(creator.adapter.resolveParticipation({
      pollId: "poll-1",
      participationId: "vote-1",
      verifiedSession: { address: OWNER },
    })).resolves.toMatchObject({ kind: "ineligible", reasonCode: "creator_not_reward_eligible" });
    expect(creator.store.loadSettlementBinding).not.toHaveBeenCalled();

    const rewarded = adapterFor();
    await expect(rewarded.adapter.resolveParticipation({
      pollId: "poll-1",
      participationId: "vote-1",
      verifiedSession: { address: PARTICIPANT },
    })).resolves.toMatchObject({
      kind: "eligible",
      context: {
        source: { type: "poll_vote", id: "vote-1" },
        eligibility: { evidenceId: "vote-1", evidenceKind: "verified_wallet_vote" },
        settlement: { id: "settlement-1", binding: { sourceType: "poll_vote", sourceId: "poll-1" } },
      },
    });
  });

  it("keeps shared participation and closure contexts free of financial or option data", () => {
    const participation = source("src/lib/rewards/participation.ts");
    const participationShape = participation.slice(
      participation.indexOf("export interface RewardParticipationContext"),
      participation.indexOf("export type RewardReservationResult"),
    );
    const closureShape = participation.slice(
      participation.indexOf("export interface RewardClosureContext"),
      participation.indexOf("export interface RewardReservationService"),
    );

    expect(participationShape).not.toMatch(/amount|capacity|vault|state|feeReserve|principal|firstReservationAt|option/i);
    expect(closureShape).not.toMatch(/amount|capacity|vault|balance|obligation|session|token|option/i);

    const invalid = {
      source: { type: "poll_vote", id: "vote-1" },
      participantWallet: PARTICIPANT,
      ownerWallet: OWNER,
      eligibility: {
        evidenceId: "vote-1",
        evidenceKind: "verified_wallet_vote",
        verifiedAt: "2026-09-13T00:00:00.000Z",
      },
      settlement: {
        id: "settlement-1",
        binding: { sourceType: "poll_vote", sourceId: "poll-1" },
      },
      optionId: "option-a",
      rewardAmountLuna: 1,
      capacity: 1,
      vaultAddressHex: "browser-vault",
      firstReservationAt: "forged",
    };
    expect(parseRewardParticipationContext(invalid)).toBeNull();

    for (const relativePath of [
      "src/lib/rewards/reservation-service.ts",
      "src/lib/rewards/settlement.ts",
      "src/lib/rewards/closure.ts",
      "src/lib/rewards/payout.ts",
      "src/lib/rewards/payout-reconciliation.ts",
      "src/lib/rewards/refund.ts",
      "src/lib/rewards/refund-reconciliation.ts",
      "src/lib/rewards/reconciliation.ts",
    ]) {
      expect(source(relativePath), relativePath).not.toMatch(/option_id|selectedOptionId|selected_option_id|winner|majority/);
    }
  });

  it("keeps Poll financial modules free of Campaign authority", () => {
    const sourceFiles = filesUnder(resolve(ROOT, "src"));
    const migrationFiles = filesUnder(resolve(ROOT, "supabase/migrations"));
    const production = sourceFiles
      .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
      .filter((file) => {
        const normalized = file.replaceAll("\\", "/");
        return !normalized.includes("/src/lib/campaigns/") && !normalized.includes("/src/app/api/campaigns/");
      })
      .filter((file) => !file.replaceAll("\\", "/").endsWith("src/types/database.ts"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const preCampaignMigrations = migrationFiles
      .filter((file) => !file.includes("20260913083000_v2c2_participation_campaigns.sql"))
      .filter((file) => !file.includes("20260913084000_v2c2_campaign_settlement_binding.sql"))
      .filter((file) => !file.includes("20260916000000_v2c3_claim_challenges.sql"));
    const migrations = preCampaignMigrations.map((file) => readFileSync(file, "utf8")).join("\n");

    expect(production).not.toMatch(/participation_campaigns|CampaignClaim|Secret Drop|Private Drop|Event Drop|Community Reward/);
    expect(migrations).not.toMatch(/participation_campaigns|campaign_claim/);
  });

  it("keeps closure/refund and financial authority in existing server boundaries", () => {
    const closureRoute = source("src/app/api/polls/[pollId]/reward/refund/route.ts");
    const refundRoute = source("src/app/api/polls/[pollId]/reward/refund/[refundId]/reconcile/route.ts");
    const reservation = source("src/lib/rewards/reservation-service.ts");
    const settlement = source("src/lib/rewards/settlement.ts");
    const closure = source("src/lib/rewards/closure.ts");

    expect(closureRoute).toContain("PollRewardClosureAdapter");
    expect(closureRoute).toContain("createSupabaseRewardClosureService");
    expect(refundRoute).toContain("resolvePollRewardSettlement");
    expect(reservation).toContain("claim_reward_receipt_atomic");
    expect(settlement).toContain("executeReservedRewardPayout");
    expect(closure).toContain("executeRewardRefund");
    expect(closure).toContain("begin_reward_refund_atomic");
    expect(closure).toContain("sessionTokenHash");
    expect(closure).not.toContain("request.json");
  });

  it("keeps selected option outside the public reward proof shape", () => {
    const rewardTypes = source("src/types/rewards.ts");
    const publicPolls = source("src/lib/data/public-polls.ts");
    const rewardTypeShapes = rewardTypes.slice(rewardTypes.indexOf("export interface RewardCampaignRow"));
    expect(rewardTypeShapes).not.toMatch(/option_id|selectedOptionId|selected_option_id/);
    expect(publicPolls).not.toMatch(/option_id|selectedOptionId|selected_option_id/);
  });

  it("documents the existing authority regressions that remain required for the final gate", () => {
    const reservationDb = source("src/lib/rewards/reservation.db.test.ts");
    const payoutDb = source("src/lib/rewards/payout.db.test.ts");
    const payoutUnit = source("src/lib/rewards/payout.test.ts");
    const refundPreparationDb = source("src/lib/rewards/refund-preparation.db.test.ts");
    const refundReconciliationDb = source("src/lib/rewards/refund-reconciliation.db.test.ts");

    expect(reservationDb).toContain("allows only one of two concurrent final-slot reservations");
    expect(reservationDb).toContain("replays the same wallet reservation without incrementing twice");
    expect(payoutDb).toContain("serializes two receipts on the same campaign vault");
    expect(payoutUnit).toContain("does not resend after an unknown broadcast outcome");
    expect(payoutUnit).toContain("leaves a recoverable durable state on signing failure");
    expect(refundPreparationDb).toContain("blocks reservation after the economic freeze");
    expect(refundPreparationDb).toContain("does not refund when payout preparation races preparation");
    expect(refundReconciliationDb).toContain("confirms one exact finalized refund");
    expect(refundReconciliationDb).toContain("serializes concurrent confirmation and performs one terminal transition");
  });
});
