import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Transaction } from "@nimiq/core";
import { createParticipationCampaign, publishParticipationCampaign } from "@/lib/campaigns/configuration";
import { issueCampaignClaimChallenge } from "@/lib/campaigns/claim-challenge";
import { ensureRewardSettlementVault, withRewardSettlementVaultKey } from "@/lib/rewards/vault-service";
import {
  buildRewardPayoutTransaction,
  signRewardPayoutTransaction,
} from "@/lib/rewards/vault-signing";
import {
  createSupabaseRewardPayoutStore,
  runRewardPayout,
  type PayoutDependencies,
  type PayoutSigningContext,
} from "@/lib/rewards/payout";
import {
  createCampaignRewardParticipationAdapter,
} from "@/lib/rewards/campaign-participation-adapter";
import { createSupabaseCampaignRewardParticipationStore } from "@/lib/campaigns/claim-participation-store";
import {
  createRewardReservationService,
  createSupabaseRewardReservationStore,
} from "@/lib/rewards/reservation-service";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import { testDbContainer, testSupabaseKey, testSupabaseUrl } from "@/lib/rewards/test-target";

const url = testSupabaseUrl();
const key = testSupabaseKey();
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const NETWORK_ID = 24;
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

interface TransportProbe {
  sends: number;
  hashes: string[];
  failNext: boolean;
  failSignNext: boolean;
}

function makeDependencies(probe: TransportProbe, seenContexts: PayoutSigningContext[]): PayoutDependencies {
  return {
    store: createSupabaseRewardPayoutStore(admin as never),
    createLockToken: randomUUID,
    sign: async (context) => withRewardSettlementVaultKey(context.campaignId, (keypair) => {
      if (probe.failSignNext) {
        probe.failSignNext = false;
        throw new Error("injected_sign_fault");
      }
      seenContexts.push({ ...context });
      const built = buildRewardPayoutTransaction({
        senderAddressHex: context.senderAddressHex,
        recipientAddressHex: context.recipientAddressHex,
        rewardPerParticipantLuna: context.amountLuna,
        feeLuna: context.feeLuna,
        validityStartHeight: context.validityStartHeight,
        networkId: context.networkId,
      });
      const signed = signRewardPayoutTransaction(built, keypair);
      return {
        ...context,
        serializedTransactionHex: signed.toHex(),
        transactionHash: signed.hash(),
      };
    }),
    // Stubbed transport boundary: deserialize the real engine-built bytes,
    // count the send, return its hash. No network contact, no NIM movement.
    broadcast: async (serializedTransactionHex) => {
      const tx = Transaction.deserialize(Buffer.from(serializedTransactionHex, "hex"));
      try {
        if (probe.failNext) {
          probe.failNext = false;
          return { kind: "definitely_not_broadcast" as const, errorCode: "injected_transport_fault" };
        }
        probe.sends += 1;
        probe.hashes.push(tx.hash());
        return { kind: "broadcast" as const, transactionHash: tx.hash() };
      } finally {
        tx.free?.();
      }
    },
    getNetworkId: () => NETWORK_ID,
    getValidityStartHeight: async () => 100,
    sleep: async () => {},
  };
}

async function openCampaign(maxParticipants = 10) {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: `Payout fixture ${hex(4)}`,
    description: null,
    visibility: "public",
    startsAt: null,
    endsAt: null,
    rewardPerParticipant: "0.5",
    maxRewardedParticipants: maxParticipants,
    fundingMode: "creator",
  });
  createdCampaignIds.push(result.campaign.campaignId);
  createdRootIds.push(result.campaign.settlementId);
  await ensureRewardSettlementVault(result.campaign.settlementId);
  await publishParticipationCampaign(OWNER, result.campaign.campaignId);
  const { error } = await admin.from("reward_settlements").update({
    status: "funded",
    funded_amount_luna: 50000 * maxParticipants,
    funded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", result.campaign.settlementId);
  if (error) throw error;
  return result.campaign;
}

async function reserve(campaignId: string, participant: string) {
  const issued = await issueCampaignClaimChallenge(admin as never, {
    campaignId,
    sessionAddress: participant,
  });
  const { data, error } = await admin.rpc("claim_campaign_reward_atomic", {
    _campaign_id: campaignId,
    _participant_wallet: participant,
    _challenge_id: issued.challengeId,
  });
  if (error) throw error;
  const row = data as Record<string, unknown>;
  if (row.result_kind !== "reserved") throw new Error(`reservation failed: ${String(row.result_kind)}`);
  return { receiptId: row.receipt_id as string, challengeId: issued.challengeId };
}

async function readReceipt(receiptId: string) {
  const { data, error } = await admin.from("reward_receipts")
    .select("id, campaign_id, poll_id, settlement_id, participant_wallet, amount_luna, status, paid_at")
    .eq("id", receiptId)
    .single();
  if (error || !data) throw error ?? new Error("receipt fixture missing");
  return data;
}

async function readAttempts(receiptId: string) {
  const { data, error } = await admin.from("reward_payout_attempts")
    .select("id, receipt_id, attempt_number, status, transaction_hash, sender_address_hex, recipient_address_hex, amount_luna, fee_luna, network_id, broadcast_started_at, broadcast_at, error_code")
    .eq("receipt_id", receiptId)
    .order("attempt_number");
  if (error) throw error;
  return data ?? [];
}

async function readSettlement(settlementId: string) {
  const { data, error } = await admin.from("reward_settlements")
    .select("status, rewarded_participant_count, paid_amount_luna, first_reservation_at")
    .eq("id", settlementId)
    .single();
  if (error || !data) throw error ?? new Error("settlement fixture missing");
  return data;
}

async function readChallenge(challengeId: string) {
  const { data, error } = await admin.from("campaign_claim_challenges")
    .select("consumed_at")
    .eq("id", challengeId)
    .single();
  if (error || !data) throw error ?? new Error("challenge fixture missing");
  return data;
}

async function confirmPaid(
  attemptId: string,
  receiptId: string,
  settlementId: string,
  transactionHash: string,
  overrides: { amountLuna?: number; recipient?: string } = {},
) {
  const receipt = await readReceipt(receiptId);
  const { data: vault } = await admin.from("reward_campaign_vaults")
    .select("vault_address_hex").eq("settlement_id", settlementId).single();
  const block = hex(32);
  const { data, error } = await admin.rpc("confirm_reward_payout_atomic", {
    _attempt_id: attemptId,
    _receipt_id: receiptId,
    _campaign_id: settlementId,
    _transaction_hash: transactionHash,
    _network_id: NETWORK_ID,
    _observed_sender: vault?.vault_address_hex as string,
    _observed_recipient: overrides.recipient ?? (receipt.participant_wallet as string),
    _observed_amount_luna: overrides.amountLuna ?? Number(receipt.amount_luna),
    _execution_result: true,
    _block_number: 100,
    _transaction_timestamp: new Date().toISOString(),
    _transaction_block_hash: block,
    _canonical_block_hash: block,
    _batch_number: 1,
    _finalizing_macro_block_height: 101,
    _finalizing_macro_block_hash: hex(32),
  });
  if (error) throw error;
  return data as Record<string, unknown>;
}

beforeAll(() => {
  assertLocalSupabaseForTests();
  process.env.NIMIQ_NETWORK_ID = String(NETWORK_ID);
});

afterAll(() => {
  const campaigns = createdCampaignIds.map((id) => `'${id}'`).join(", ");
  const roots = createdRootIds.map((id) => `'${id}'`).join(", ");
  if (campaigns.length === 0) return;
  runPsql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.reward_payout_attempts WHERE receipt_id IN (SELECT id FROM public.reward_receipts WHERE settlement_id IN (${roots}));
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

describe("campaign payout through the shared engine", () => {
  it("pays a Campaign receipt once with server-owned terms and full provenance", async () => {
    const campaign = await openCampaign();
    const claimant = wallet(71);
    const { receiptId, challengeId } = await reserve(campaign.campaignId, claimant);
    const settlementBefore = await readSettlement(campaign.settlementId);
    const probe: TransportProbe = { sends: 0, hashes: [], failNext: false, failSignNext: false };
    const seenContexts: PayoutSigningContext[] = [];
    const deps = makeDependencies(probe, seenContexts);

    const executed = await runRewardPayout(
      { receiptId, campaignId: campaign.settlementId }, deps,
    );
    expect(executed.kind).toBe("broadcasted");
    if (executed.kind !== "broadcasted") throw new Error("expected broadcast");
    expect(probe.sends).toBe(1);

    // Signing context derives entirely from persisted server state.
    expect(seenContexts).toHaveLength(1);
    const { data: vault } = await admin.from("reward_campaign_vaults")
      .select("vault_address_hex").eq("settlement_id", campaign.settlementId).single();
    expect(seenContexts[0]).toMatchObject({
      senderAddressHex: vault?.vault_address_hex,
      recipientAddressHex: claimant,
      amountLuna: BigInt(50000),
    });

    const attempts = await readAttempts(receiptId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt_number: 1,
      status: "pending",
      sender_address_hex: vault?.vault_address_hex,
      recipient_address_hex: claimant,
    });
    expect(String(attempts[0].amount_luna)).toBe("50000");
    expect(attempts[0].transaction_hash).toBe(executed.transactionHash);
    expect(attempts[0].broadcast_started_at).not.toBeNull();
    expect(attempts[0].broadcast_at).not.toBeNull();

    const mid = await readReceipt(receiptId);
    expect(mid).toMatchObject({
      campaign_id: null,
      poll_id: null,
      settlement_id: campaign.settlementId,
      status: "payout_pending",
    });

    const confirmed = await confirmPaid(
      attempts[0].id as string, receiptId, campaign.settlementId, executed.transactionHash,
    );
    expect(confirmed.result_kind).toBe("confirmed");

    const paid = await readReceipt(receiptId);
    expect(paid.status).toBe("paid");
    expect(paid.paid_at).not.toBeNull();
    const settled = await readSettlement(campaign.settlementId);
    expect(Number(settled.paid_amount_luna)).toBe(50000);
    expect(settled.rewarded_participant_count).toBe(settlementBefore.rewarded_participant_count);
    expect(settled.first_reservation_at).toBe(settlementBefore.first_reservation_at);
    expect((await readChallenge(challengeId)).consumed_at).not.toBeNull();
  });

  it("sends at most once across repeated and overlapping executions", async () => {
    const campaign = await openCampaign();
    const claimant = wallet(72);
    const { receiptId } = await reserve(campaign.campaignId, claimant);
    const probe: TransportProbe = { sends: 0, hashes: [], failNext: false, failSignNext: false };
    const deps = makeDependencies(probe, []);

    const first = await runRewardPayout({ receiptId, campaignId: campaign.settlementId }, deps);
    expect(first.kind).toBe("broadcasted");

    const second = await runRewardPayout({ receiptId, campaignId: campaign.settlementId }, deps);
    expect(second).toMatchObject({ kind: "already_pending" });

    const overlapping = await Promise.all(
      Array.from({ length: 3 }, () => runRewardPayout({ receiptId, campaignId: campaign.settlementId }, deps)),
    );
    for (const outcome of overlapping) {
      expect(["already_pending", "broadcasted", "busy"]).toContain(outcome.kind);
    }
    expect(probe.sends).toBeLessThanOrEqual(1);
    expect(await readAttempts(receiptId)).toHaveLength(1);
    const receipt = await readReceipt(receiptId);
    expect(receipt.status).toBe("payout_pending");
    expect((await readSettlement(campaign.settlementId)).rewarded_participant_count).toBe(1);
  });

  it("keeps the reservation durable when transport fails deterministically", async () => {
    const campaign = await openCampaign();
    const claimant = wallet(73);
    const { receiptId, challengeId } = await reserve(campaign.campaignId, claimant);
    const settlementBefore = await readSettlement(campaign.settlementId);
    const probe: TransportProbe = { sends: 0, hashes: [], failNext: true, failSignNext: false };
    const deps = makeDependencies(probe, []);

    const failed = await runRewardPayout({ receiptId, campaignId: campaign.settlementId }, deps);
    expect(failed).toMatchObject({ kind: "retryable" });
    expect(probe.sends).toBe(0);

    const attempts = await readAttempts(receiptId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("retryable");
    expect(attempts[0].error_code).toBe("injected_transport_fault");

    const receipt = await readReceipt(receiptId);
    expect(receipt.status).toBe("retryable");
    const settled = await readSettlement(campaign.settlementId);
    expect(settled.rewarded_participant_count).toBe(settlementBefore.rewarded_participant_count);
    expect(settled.first_reservation_at).toBe(settlementBefore.first_reservation_at);
    expect((await readChallenge(challengeId)).consumed_at).not.toBeNull();

    // Hash-bearing attempts must reconcile, never blindly retry.
    const { data: noBlindRetry } = await admin.rpc("retry_reward_payout_atomic", {
      _receipt_id: receiptId,
      _campaign_id: campaign.settlementId,
    });
    expect((noBlindRetry as Record<string, unknown>).result_kind).toBe("reconciliation_required");
  });

  it("retries the same receipt once after failure and reaches paid", async () => {
    const campaign = await openCampaign();
    const claimant = wallet(74);
    const { receiptId } = await reserve(campaign.campaignId, claimant);
    // Sign-stage fault: no prepared hash exists, so the engine retry path
    // (not reconciliation) owns recovery.
    const probe: TransportProbe = { sends: 0, hashes: [], failNext: false, failSignNext: true };
    const deps = makeDependencies(probe, []);

    const failed = await runRewardPayout({ receiptId, campaignId: campaign.settlementId }, deps);
    expect(failed.kind).toBe("retryable");

    const { data: retried, error: retryError } = await admin.rpc("retry_reward_payout_atomic", {
      _receipt_id: receiptId,
      _campaign_id: campaign.settlementId,
    });
    if (retryError) throw retryError;
    expect((retried as Record<string, unknown>).result_kind).toBe("retryable");

    const second = await runRewardPayout({ receiptId, campaignId: campaign.settlementId }, deps);
    expect(second.kind).toBe("broadcasted");
    expect(probe.sends).toBe(1);

    const attempts = await readAttempts(receiptId);
    expect(attempts.map((row) => row.attempt_number)).toEqual([1, 2]);
    const confirmed = await confirmPaid(
      attempts[1].id as string, receiptId, campaign.settlementId,
      second.kind === "broadcasted" ? second.transactionHash : "",
    );
    expect(confirmed.result_kind).toBe("confirmed");
    expect((await readReceipt(receiptId)).status).toBe("paid");
    expect((await readSettlement(campaign.settlementId)).rewarded_participant_count).toBe(1);
  });

  it("replays an already-paid claim with no additional send", async () => {
    const campaign = await openCampaign();
    const claimant = wallet(75);
    const { receiptId } = await reserve(campaign.campaignId, claimant);
    const probe: TransportProbe = { sends: 0, hashes: [], failNext: false, failSignNext: false };
    const deps = makeDependencies(probe, []);

    const first = await runRewardPayout({ receiptId, campaignId: campaign.settlementId }, deps);
    expect(first.kind).toBe("broadcasted");
    const attempts = await readAttempts(receiptId);
    const confirmed = await confirmPaid(
      attempts[0].id as string, receiptId, campaign.settlementId,
      first.kind === "broadcasted" ? first.transactionHash : "",
    );
    expect(confirmed.result_kind).toBe("confirmed");
    const sendsAfterPaid = probe.sends;

    // Claim replay through the supported adapter/service path.
    const adapter = createCampaignRewardParticipationAdapter(
      createSupabaseCampaignRewardParticipationStore(admin as never),
    );
    const service = createRewardReservationService(
      createSupabaseRewardReservationStore(admin as never),
    );
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
    if (participation.kind !== "eligible") throw new Error("expected eligible replay");
    const replay = await service.reserve(participation.context);
    expect(replay).toMatchObject({ kind: "replay", receiptId });

    // Payout follow-up on the paid receipt sends nothing further.
    const followUp = await runRewardPayout({ receiptId, campaignId: campaign.settlementId }, deps);
    expect(followUp.kind).toBe("rejected");
    expect(probe.sends).toBe(sendsAfterPaid);
    expect((await readReceipt(receiptId)).status).toBe("paid");
  });

  it("derives amount, recipient, and receipt identity from server state only", async () => {
    const campaign = await openCampaign();
    const claimant = wallet(76);
    const { receiptId } = await reserve(campaign.campaignId, claimant);
    const probe: TransportProbe = { sends: 0, hashes: [], failNext: false, failSignNext: false };
    const deps = makeDependencies(probe, []);

    // Forged settlement association cannot touch another entitlement.
    const other = await openCampaign();
    const crossBranch = await runRewardPayout({ receiptId, campaignId: other.settlementId }, deps);
    expect(crossBranch).toMatchObject({ kind: "rejected" });
    expect(probe.sends).toBe(0);

    const executed = await runRewardPayout({ receiptId, campaignId: campaign.settlementId }, deps);
    expect(executed.kind).toBe("broadcasted");
    const attempts = await readAttempts(receiptId);
    expect(attempts).toHaveLength(1);

    // Forged confirmation economics are rejected against persisted rows.
    const wrongAmount = await confirmPaid(
      attempts[0].id as string, receiptId, campaign.settlementId,
      executed.kind === "broadcasted" ? executed.transactionHash : "",
      { amountLuna: 1 },
    );
    expect(wrongAmount.result_kind).toBe("amount_mismatch");
    const wrongRecipient = await confirmPaid(
      attempts[0].id as string, receiptId, campaign.settlementId,
      executed.kind === "broadcasted" ? executed.transactionHash : "",
      { recipient: wallet(77) },
    );
    expect(wrongRecipient.result_kind).toBe("wrong_recipient");
    expect((await readReceipt(receiptId)).status).toBe("payout_pending");
    expect((await readAttempts(receiptId))).toHaveLength(1);
  });
});
