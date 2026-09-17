import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createParticipationCampaign, publishParticipationCampaign } from "@/lib/campaigns/configuration";
import { issueCampaignClaimChallenge } from "@/lib/campaigns/claim-challenge";
import { beginCampaignFunding, bindCampaignFunding } from "@/lib/campaigns/funding";
import { ensureRewardSettlementVault } from "@/lib/rewards/vault-service";
import {
  createCampaignRewardParticipationAdapter,
} from "@/lib/rewards/campaign-participation-adapter";
import { createSupabaseCampaignRewardParticipationStore } from "@/lib/campaigns/claim-participation-store";
import {
  createRewardReservationService,
  createSupabaseRewardReservationStore,
} from "@/lib/rewards/reservation-service";
import {
  createDefaultFundingConfirmationDependencies,
  loadFundingConfirmationContext,
  reconcileFundingIntent,
} from "@/lib/rewards/funding-confirmation";
import type { FundingObservation } from "@/lib/rewards/reconciliation";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import { testDbContainer, testSupabaseKey, testSupabaseUrl } from "@/lib/rewards/test-target";

const url = testSupabaseUrl();
const key = testSupabaseKey();
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const OWNER = "01" + "c".repeat(38);
const createdCampaignIds: string[] = [];
const createdRootIds: string[] = [];

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function wallet(seed: number): string {
  return "02" + seed.toString(16).padStart(2, "0") + "a".repeat(36);
}

function runPsql(sql: string): void {
  execFileSync("docker", [
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-c", sql,
  ], { stdio: "pipe" });
}

function observedFunding(hash: string, vaultHex: string, amountLuna: bigint, reference: string): FundingObservation {
  const block = hex(32);
  return {
    kind: "found",
    transaction: {
      transactionHash: hash,
      blockHash: block,
      networkId: 24,
      sender: OWNER,
      recipient: vaultHex,
      valueLuna: amountLuna,
      memo: reference,
      executionResult: true,
      blockHeight: 100,
      timestampMs: Date.now(),
      confirmationCount: 10,
      finality: "final",
      finalityReason: null,
      finalityEvidence: {
        transactionBlockHeight: 100,
        transactionBlockHash: block,
        canonicalBlockHash: block,
        canonicalBlockVerified: true,
        batchNumber: 1,
        finalizingMacroBlockHeight: 101,
        finalizingMacroBlockHash: hex(32),
      },
    },
  };
}

async function createFundedCampaign(maxParticipants = 10) {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: `Reservation fixture ${hex(4)}`,
    description: null,
    visibility: "unlisted",
    startsAt: null,
    endsAt: null,
    rewardPerParticipant: "0.5",
    maxRewardedParticipants: maxParticipants,
    fundingMode: "creator",
  });
  createdCampaignIds.push(result.campaign.campaignId);
  createdRootIds.push(result.campaign.settlementId);
  await publishParticipationCampaign(OWNER, result.campaign.campaignId);
  await ensureRewardSettlementVault(result.campaign.settlementId);
  const started = await beginCampaignFunding(admin as never, result.campaign.campaignId, OWNER);
  if (started.kind !== "created") throw new Error(`fund begin failed: ${started.kind}`);
  const txHash = hex(32);
  const bound = await bindCampaignFunding(
    admin as never, result.campaign.campaignId, started.fundingIntent.fundingIntentId, OWNER, txHash,
  );
  if (bound.kind !== "bound") throw new Error(`fund bind failed: ${bound.kind}`);
  const loaded = await loadFundingConfirmationContext(
    admin as never, result.campaign.settlementId, started.fundingIntent.fundingIntentId, OWNER,
  );
  if (loaded.kind !== "ok") throw new Error("fund context not loadable");
  const deps = createDefaultFundingConfirmationDependencies(admin as never);
  const confirmed = await reconcileFundingIntent(loaded.context, {
    ...deps,
    observeFundingByHash: async () => observedFunding(
      txHash, started.fundingIntent.vaultAddressHex, BigInt(started.fundingIntent.requiredFundingLuna), started.fundingIntent.reference,
    ),
  });
  if (confirmed.kind !== "confirmed") throw new Error(`fund confirm failed: ${confirmed.kind}`);
  return result.campaign;
}

function stack() {
  const adapter = createCampaignRewardParticipationAdapter(
    createSupabaseCampaignRewardParticipationStore(admin as never),
  );
  const service = createRewardReservationService(
    createSupabaseRewardReservationStore(admin as never),
  );
  return { adapter, service };
}

async function reserve(campaignId: string, sessionWallet: string) {
  const { adapter, service } = stack();
  const issued = await issueCampaignClaimChallenge(admin as never, {
    campaignId,
    sessionAddress: sessionWallet,
  });
  const participation = await adapter.resolveParticipation({
    campaignId,
    challengeId: issued.challengeId,
    verifiedSession: { address: sessionWallet },
  });
  if (participation.kind !== "eligible") return { issued, participation, reservation: null as null };
  const reservation = await service.reserve(participation.context);
  return { issued, participation, reservation };
}

async function challengeConsumed(challengeId: string): Promise<boolean> {
  const { data } = await admin.from("campaign_claim_challenges")
    .select("consumed_at")
    .eq("id", challengeId)
    .single();
  return (data?.consumed_at as string | null) !== null;
}

async function receiptCount(settlementId: string): Promise<number> {
  const { data } = await admin.from("reward_receipts")
    .select("id")
    .eq("settlement_id", settlementId);
  return data?.length ?? -1;
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterAll(() => {
  const campaigns = createdCampaignIds.map((id) => `'${id}'`).join(", ");
  const roots = createdRootIds.map((id) => `'${id}'`).join(", ");
  if (campaigns.length === 0) return;
  runPsql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.campaign_claim_challenges WHERE campaign_id IN (${campaigns});
    DELETE FROM public.reward_funding_transactions WHERE settlement_id IN (${roots});
    DELETE FROM public.reward_receipts WHERE settlement_id IN (${roots});
    DELETE FROM public.reward_refunds WHERE settlement_id IN (${roots});
    DELETE FROM public.reward_campaign_vaults WHERE settlement_id IN (${roots});
    DELETE FROM public.settlement_source_bindings WHERE settlement_id IN (${roots});
    DELETE FROM public.participation_campaigns WHERE id IN (${campaigns});
    DELETE FROM public.reward_settlements WHERE id IN (${roots});
    COMMIT;
  `);
  createdCampaignIds.length = 0;
  createdRootIds.length = 0;
});

describe("campaign reservation service against the atomic RPC", () => {
  it("reserves through adapter plus service with a NULL-branch receipt", async () => {
    const campaign = await createFundedCampaign();
    const claimant = wallet(21);
    const { reservation } = await reserve(campaign.campaignId, claimant);

    expect(reservation).toMatchObject({ kind: "reserved", settlementId: campaign.settlementId });
    if (reservation?.kind !== "reserved") throw new Error("expected reservation");
    expect(reservation.receiptId).toBeTruthy();
    expect(reservation.receiptStatus).toBe("reserved");

    const { data: receipt } = await admin.from("reward_receipts")
      .select("campaign_id, poll_id, settlement_id, amount_luna, status")
      .eq("id", reservation.receiptId)
      .single();
    expect(receipt).toMatchObject({
      campaign_id: null,
      poll_id: null,
      settlement_id: campaign.settlementId,
      status: "reserved",
    });
    expect(String(receipt?.amount_luna)).toBe("50000");
  });

  it("replays the same receipt on retry, including after exhaustion", async () => {
    const campaign = await createFundedCampaign(1);
    const claimant = wallet(22);
    const { adapter, service } = stack();
    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: claimant,
    });
    const participation = await adapter.resolveParticipation({
      campaignId: campaign.campaignId,
      challengeId: issued.challengeId,
      verifiedSession: { address: claimant },
    });
    expect(participation.kind).toBe("eligible");
    if (participation.kind !== "eligible") throw new Error("expected eligible context");

    const first = await service.reserve(participation.context);
    expect(first.kind).toBe("reserved");
    const receiptId = first.kind === "reserved" ? first.receiptId : "";

    // Exact retry with the same now-consumed challenge passes the adapter
    // (consumption is RPC-authoritative) and replays the original receipt.
    const retryParticipation = await adapter.resolveParticipation({
      campaignId: campaign.campaignId,
      challengeId: issued.challengeId,
      verifiedSession: { address: claimant },
    });
    expect(retryParticipation.kind).toBe("eligible");
    if (retryParticipation.kind !== "eligible") throw new Error("expected eligible retry");
    const replay = await service.reserve(retryParticipation.context);
    expect(replay).toEqual({
      kind: "replay",
      settlementId: campaign.settlementId,
      receiptId,
      receiptStatus: "reserved",
    });
    expect(await receiptCount(campaign.settlementId)).toBe(1);
  });

  it("fails a consumed challenge with no reservation closed without writes", async () => {
    const campaign = await createFundedCampaign();
    const claimant = wallet(28);
    const { adapter, service } = stack();
    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: claimant,
    });
    runPsql(`UPDATE public.campaign_claim_challenges
      SET consumed_at = '${new Date().toISOString()}' WHERE id = '${issued.challengeId}';`);

    const participation = await adapter.resolveParticipation({
      campaignId: campaign.campaignId,
      challengeId: issued.challengeId,
      verifiedSession: { address: claimant },
    });
    expect(participation.kind).toBe("eligible");
    if (participation.kind !== "eligible") throw new Error("expected eligible context");
    await expect(service.reserve(participation.context)).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "challenge_consumed",
    });
    expect(await receiptCount(campaign.settlementId)).toBe(0);
  });

  it("consumes a fresh challenge atomically when replaying", async () => {
    const campaign = await createFundedCampaign();
    const claimant = wallet(23);
    const first = await reserve(campaign.campaignId, claimant);
    expect(first.reservation?.kind).toBe("reserved");

    const second = await reserve(campaign.campaignId, claimant);
    expect(second.reservation?.kind).toBe("replay");
    expect(await challengeConsumed(second.issued.challengeId)).toBe(true);
    expect(await receiptCount(campaign.settlementId)).toBe(1);
  });

  it("rejects over-capacity wallets without consuming their challenge", async () => {
    const campaign = await createFundedCampaign(1);
    const winner = await reserve(campaign.campaignId, wallet(24));
    expect(winner.reservation?.kind).toBe("reserved");

    const loser = await reserve(campaign.campaignId, wallet(25));
    expect(loser.reservation).toMatchObject({ kind: "ineligible", reasonCode: "no_reward_capacity" });
    expect(await challengeConsumed(loser.issued.challengeId)).toBe(false);
    expect(await receiptCount(campaign.settlementId)).toBe(1);
  });

  it("rejects the creator and unfunded campaigns without side effects", async () => {
    const campaign = await createFundedCampaign();
    const { participation } = await (async () => {
      const { adapter } = stack();
      const issued = await issueCampaignClaimChallenge(admin as never, {
        campaignId: campaign.campaignId,
        sessionAddress: OWNER,
      });
      return {
        issued,
        participation: await adapter.resolveParticipation({
          campaignId: campaign.campaignId,
          challengeId: issued.challengeId,
          verifiedSession: { address: OWNER },
        }),
      };
    })();
    expect(participation).toMatchObject({ kind: "ineligible", reasonCode: "creator_not_reward_eligible" });

    const draft = await createParticipationCampaign(OWNER, {
      type: "public_giveaway",
      title: `Unfunded reservation fixture ${hex(4)}`,
      description: null,
      visibility: "unlisted",
      startsAt: null,
      endsAt: null,
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 10,
      fundingMode: "creator",
    });
    createdCampaignIds.push(draft.campaign.campaignId);
    createdRootIds.push(draft.campaign.settlementId);
    await publishParticipationCampaign(OWNER, draft.campaign.campaignId);
    const pending = await reserve(draft.campaign.campaignId, wallet(26));
    expect(pending.reservation).toMatchObject({ kind: "ineligible", reasonCode: "campaign_not_funded" });
    expect(await receiptCount(draft.campaign.settlementId)).toBe(0);
  });

  it("surfaces expired challenges as ineligible without writes", async () => {
    const campaign = await createFundedCampaign();
    const claimant = wallet(27);
    const { adapter, service } = stack();
    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: claimant,
    });
    runPsql(`UPDATE public.campaign_claim_challenges
      SET issued_at = '${new Date(Date.now() - 10 * 60 * 1000).toISOString()}',
          expires_at = '${new Date(Date.now() - 60_000).toISOString()}'
      WHERE id = '${issued.challengeId}';`);
    const participation = await adapter.resolveParticipation({
      campaignId: campaign.campaignId,
      challengeId: issued.challengeId,
      verifiedSession: { address: claimant },
    });
    expect(participation.kind).toBe("eligible");
    if (participation.kind !== "eligible") throw new Error("expected eligible context");
    await expect(service.reserve(participation.context)).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "challenge_expired",
    });
    expect(await receiptCount(campaign.settlementId)).toBe(0);
  });
});
