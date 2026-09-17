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
  createSupabaseRewardRefundStore,
  runRewardRefund,
  type RefundDependencies,
} from "@/lib/rewards/refund";
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
const createdTokenHashes: string[] = [];

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

function makeDependencies(probe: TransportProbe): RefundDependencies {
  return {
    store: createSupabaseRewardRefundStore(admin as never),
    createLockToken: randomUUID,
    sign: async (context) => withRewardSettlementVaultKey(context.campaignId, (keypair) => {
      if (probe.failSignNext) {
        probe.failSignNext = false;
        throw new Error("injected_sign_fault");
      }
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
    getFeeLuna: () => BigInt(1000),
    getValidityStartHeight: async () => 100,
    sleep: async () => {},
  };
}

async function openCampaign(maxParticipants = 10) {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: `Refund execution fixture ${hex(4)}`,
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
  const { data: terms, error: termsError } = await admin.from("reward_settlements")
    .select("total_budget_luna")
    .eq("id", result.campaign.settlementId)
    .single();
  if (termsError || !terms) throw termsError ?? new Error("settlement terms missing");
  const { error } = await admin.from("reward_settlements").update({
    status: "funded",
    funded_amount_luna: terms.total_budget_luna,
    funded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", result.campaign.settlementId);
  if (error) throw error;
  return result.campaign;
}

async function ownerSession(): Promise<string> {
  const tokenHash = hex(32);
  const { error } = await admin.from("wallet_sessions").insert({
    token_hash: tokenHash,
    wallet_address: OWNER,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    revoked_at: null,
  });
  if (error) throw error;
  createdTokenHashes.push(tokenHash);
  return tokenHash;
}

async function closeCampaign(campaignId: string) {
  const { data, error } = await admin.rpc("close_participation_campaign_atomic", {
    _campaign_id: campaignId,
    _owner_wallet: OWNER,
  });
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function beginRefund(settlementId: string, tokenHash: string) {
  const { data, error } = await admin.rpc("begin_campaign_refund_atomic", {
    _settlement_id: settlementId,
    _session_token_hash: tokenHash,
  });
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function readRefund(refundId: string) {
  const { data, error } = await admin.from("reward_refunds")
    .select("id, campaign_id, settlement_id, creator_wallet, amount_luna, status, transaction_hash, prepared_transaction_hash, sender_address_hex, recipient_address_hex, fee_luna, network_id, broadcast_started_at, broadcast_at")
    .eq("id", refundId)
    .single();
  if (error || !data) throw error ?? new Error("refund fixture missing");
  return data;
}

async function readSettlement(settlementId: string) {
  const { data, error } = await admin.from("reward_settlements")
    .select("status, rewarded_participant_count, paid_amount_luna, refundable_amount_luna, refunded_at, first_reservation_at")
    .eq("id", settlementId)
    .single();
  if (error || !data) throw error ?? new Error("settlement fixture missing");
  return data;
}

async function confirmRefund(
  refundId: string,
  settlementId: string,
  transactionHash: string,
  overrides: { amountLuna?: number; recipient?: string } = {},
) {
  const refund = await readRefund(refundId);
  const { data: vault } = await admin.from("reward_campaign_vaults")
    .select("vault_address_hex").eq("settlement_id", settlementId).single();
  const block = hex(32);
  const { data, error } = await admin.rpc("confirm_reward_refund_atomic", {
    _refund_id: refundId,
    _campaign_id: settlementId,
    _transaction_hash: transactionHash,
    _network_id: NETWORK_ID,
    _observed_sender: vault?.vault_address_hex as string,
    _observed_recipient: overrides.recipient ?? (refund.creator_wallet as string),
    _observed_amount_luna: overrides.amountLuna ?? Number(refund.amount_luna),
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
  if (campaigns.length > 0) {
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
  }
  if (createdTokenHashes.length > 0) {
    const hashes = createdTokenHashes.map((h) => `'${h}'`).join(", ");
    runPsql(`DELETE FROM public.wallet_sessions WHERE token_hash IN (${hashes});`);
    createdTokenHashes.length = 0;
  }
});

describe("campaign refund execution through the shared engine", () => {
  it("executes a Campaign refund to paid with full provenance", async () => {
    const campaign = await openCampaign(4);
    const token = await ownerSession();
    expect(await closeCampaign(campaign.campaignId)).toMatchObject({ result_kind: "closed" });
    const begun = await beginRefund(campaign.settlementId, token);
    expect(begun.result_kind).toBe("created");
    const refundId = begun.refund_id as string;
    const settlementBefore = await readSettlement(campaign.settlementId);

    const probe: TransportProbe = { sends: 0, hashes: [], failNext: false, failSignNext: false };
    const executed = await runRewardRefund(
      { refundId, campaignId: campaign.settlementId },
      makeDependencies(probe),
    );
    expect(executed.kind).toBe("broadcasted");
    if (executed.kind !== "broadcasted") throw new Error("expected broadcast");
    expect(probe.sends).toBe(1);

    const row = await readRefund(refundId);
    expect(row).toMatchObject({
      campaign_id: null,
      settlement_id: campaign.settlementId,
      creator_wallet: OWNER,
      status: "pending",
    });
    expect(String(row.amount_luna)).toBe(String(begun.amount_luna));
    expect(row.sender_address_hex).toBeTruthy();
    expect(row.recipient_address_hex).toBe(OWNER);
    expect(row.transaction_hash).toBe(executed.transactionHash);
    expect(row.broadcast_started_at).not.toBeNull();
    expect(row.broadcast_at).not.toBeNull();

    const confirmed = await confirmRefund(refundId, campaign.settlementId, executed.transactionHash);
    expect(confirmed.result_kind).toBe("confirmed");

    const paid = await readRefund(refundId);
    expect(paid.status).toBe("confirmed");
    const settled = await readSettlement(campaign.settlementId);
    expect(settled.status).toBe("refunded");
    expect(settled.refunded_at).not.toBeNull();
    expect(settled.rewarded_participant_count).toBe(settlementBefore.rewarded_participant_count);
    expect(settled.first_reservation_at).toBe(settlementBefore.first_reservation_at);
  });

  it("sends at most once across repeated and overlapping executions", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    await closeCampaign(campaign.campaignId);
    const begun = await beginRefund(campaign.settlementId, token);
    const refundId = begun.refund_id as string;
    const probe: TransportProbe = { sends: 0, hashes: [], failNext: false, failSignNext: false };
    const deps = makeDependencies(probe);

    const first = await runRewardRefund({ refundId, campaignId: campaign.settlementId }, deps);
    expect(first.kind).toBe("broadcasted");

    const second = await runRewardRefund({ refundId, campaignId: campaign.settlementId }, deps);
    expect(second).toMatchObject({ kind: "already_pending" });

    const overlapping = await Promise.all(
      Array.from({ length: 3 }, () => runRewardRefund({ refundId, campaignId: campaign.settlementId }, deps)),
    );
    for (const outcome of overlapping) {
      expect(["already_pending", "broadcasted", "busy", "unknown"]).toContain(outcome.kind);
    }
    expect(probe.sends).toBeLessThanOrEqual(1);
  });

  it("keeps a definite transport failure recoverable without side effects", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    await closeCampaign(campaign.campaignId);
    const begun = await beginRefund(campaign.settlementId, token);
    const refundId = begun.refund_id as string;

    const probe: TransportProbe = { sends: 0, hashes: [], failNext: false, failSignNext: true };
    const failed = await runRewardRefund(
      { refundId, campaignId: campaign.settlementId },
      makeDependencies(probe),
    );
    expect(failed).toMatchObject({ kind: "retryable" });
    expect(probe.sends).toBe(0);

    const row = await readRefund(refundId);
    expect(row.status).toBe("retryable");
    expect(row.transaction_hash).toBeNull();
    expect((await readSettlement(campaign.settlementId)).status).toBe("refunding");
  });

  it("retries the same intent once after safe failure and reaches refunded", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    await closeCampaign(campaign.campaignId);
    const begun = await beginRefund(campaign.settlementId, token);
    const refundId = begun.refund_id as string;

    const probe: TransportProbe = { sends: 0, hashes: [], failNext: false, failSignNext: true };
    const deps = makeDependencies(probe);
    const failed = await runRewardRefund({ refundId, campaignId: campaign.settlementId }, deps);
    expect(failed.kind).toBe("retryable");

    const second = await runRewardRefund({ refundId, campaignId: campaign.settlementId }, deps);
    expect(second.kind).toBe("broadcasted");
    expect(probe.sends).toBe(1);

    const confirmed = await confirmRefund(
      refundId, campaign.settlementId,
      second.kind === "broadcasted" ? second.transactionHash : "",
    );
    expect(confirmed.result_kind).toBe("confirmed");
    expect((await readRefund(refundId)).status).toBe("confirmed");
    expect((await readSettlement(campaign.settlementId)).status).toBe("refunded");
  });

  it("never blind-resends a hash-bearing unknown outcome", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    await closeCampaign(campaign.campaignId);
    const begun = await beginRefund(campaign.settlementId, token);
    const refundId = begun.refund_id as string;

    const probe: TransportProbe = { sends: 0, hashes: [], failNext: true, failSignNext: false };
    const deps = makeDependencies(probe);
    const ambiguous = await runRewardRefund({ refundId, campaignId: campaign.settlementId }, deps);
    expect(ambiguous.kind).toBe("unknown");

    // Retry cannot broadcast again until reconciliation resolves the hash.
    const retry = await runRewardRefund({ refundId, campaignId: campaign.settlementId }, deps);
    expect(retry.kind).toBe("unknown");
    expect(probe.sends).toBe(0);
    expect((await readSettlement(campaign.settlementId)).status).toBe("refunding");

    // Reconciliation observes the prepared hash on chain (broadcast marker),
    // then confirmation completes without any second send.
    const row = await readRefund(refundId);
    const { data: marked, error: markError } = await admin.rpc("mark_reward_refund_broadcast_atomic", {
      _refund_id: refundId,
      _transaction_hash: row.prepared_transaction_hash as string,
    });
    if (markError) throw markError;
    expect((marked as Record<string, unknown>).result_kind).toBe("broadcasted");
    const confirmed = await confirmRefund(refundId, campaign.settlementId, row.prepared_transaction_hash as string);
    expect(confirmed.result_kind).toBe("confirmed");
    expect(probe.sends).toBe(0);
    expect((await readSettlement(campaign.settlementId)).status).toBe("refunded");
  });

  it("replays an already-refunded intent with no additional send", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    await closeCampaign(campaign.campaignId);
    const begun = await beginRefund(campaign.settlementId, token);
    const refundId = begun.refund_id as string;
    const probe: TransportProbe = { sends: 0, hashes: [], failNext: false, failSignNext: false };
    const deps = makeDependencies(probe);

    const first = await runRewardRefund({ refundId, campaignId: campaign.settlementId }, deps);
    expect(first.kind).toBe("broadcasted");
    const row = await readRefund(refundId);
    const confirmed = await confirmRefund(refundId, campaign.settlementId, row.transaction_hash as string);
    expect(confirmed.result_kind).toBe("confirmed");
    const sendsAfterPaid = probe.sends;

    expect(await beginRefund(campaign.settlementId, token)).toMatchObject({
      result_kind: "already_refunded_or_closed",
      refund_id: refundId,
    });
    // Terminal replay is a fail-closed rejection, not a new execution: no
    // send, no new intent, refunded stays terminal with provenance intact.
    const replay = await runRewardRefund({ refundId, campaignId: campaign.settlementId }, deps);
    expect(replay).toMatchObject({ kind: "rejected", reasonCode: "campaign_not_refunding" });
    expect(probe.sends).toBe(sendsAfterPaid);
    expect((await readSettlement(campaign.settlementId)).status).toBe("refunded");
  });

  it("derives amount, recipient, and identity from server state only", async () => {
    const campaign = await openCampaign();
    const token = await ownerSession();
    await closeCampaign(campaign.campaignId);
    const begun = await beginRefund(campaign.settlementId, token);
    const refundId = begun.refund_id as string;
    const probe: TransportProbe = { sends: 0, hashes: [], failNext: false, failSignNext: false };
    const deps = makeDependencies(probe);

    // Cross-settlement association is rejected with no send.
    const other = await openCampaign();
    const crossBranch = await runRewardRefund({ refundId, campaignId: other.settlementId }, deps);
    expect(crossBranch).toMatchObject({ kind: "rejected" });
    expect(probe.sends).toBe(0);

    const executed = await runRewardRefund({ refundId, campaignId: campaign.settlementId }, deps);
    expect(executed.kind).toBe("broadcasted");

    // Forged confirmation economics are rejected against persisted rows.
    const row = await readRefund(refundId);
    const txHash = row.transaction_hash as string;
    const wrongAmount = await confirmRefund(refundId, campaign.settlementId, txHash, {
      amountLuna: Number(row.amount_luna) + 1,
    });
    expect(wrongAmount.result_kind).toBe("amount_mismatch");
    const wrongRecipient = await confirmRefund(refundId, campaign.settlementId, txHash, {
      recipient: wallet(201),
    });
    expect(wrongRecipient.result_kind).toBe("wrong_recipient");
    expect((await readRefund(refundId)).status).toBe("pending");
  });

  it("refunds only the remainder when a reward was paid", async () => {
    const campaign = await openCampaign(2);
    const token = await ownerSession();
    const claimant = wallet(202);
    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: claimant,
    });
    const { data: claimed, error: claimError } = await admin.rpc("claim_campaign_reward_atomic", {
      _campaign_id: campaign.campaignId,
      _participant_wallet: claimant,
      _challenge_id: issued.challengeId,
    });
    if (claimError) throw claimError;
    expect((claimed as Record<string, unknown>).result_kind).toBe("reserved");
    const receiptId = (claimed as Record<string, unknown>).receipt_id as string;

    // Settle the reward through the canonical paid state pre-close (no
    // payout attempt exists in this fixture; the paid receipt plus
    // settlement paid_amount carry the settled obligation).
    runPsql(`UPDATE public.reward_receipts SET status = 'paid', paid_at = now() WHERE id = '${receiptId}';
      UPDATE public.reward_settlements SET paid_amount_luna = 50000 WHERE id = '${campaign.settlementId}';`);
    await closeCampaign(campaign.campaignId);
    const begun = await beginRefund(campaign.settlementId, token);
    expect(begun.result_kind).toBe("created");

    const { data: economics } = await admin.from("reward_settlements")
      .select("reward_principal_luna, fee_reserve_luna, refundable_excess_luna")
      .eq("id", campaign.settlementId)
      .single();
    const expected = BigInt(economics?.reward_principal_luna as string)
      - BigInt(50000)
      + BigInt(economics?.fee_reserve_luna as string)
      + BigInt(economics?.refundable_excess_luna as string);
    expect(String(begun.amount_luna)).toBe(String(expected));
    expect(Number(begun.amount_luna)).toBeLessThan(Number(economics?.reward_principal_luna));

    const probe: TransportProbe = { sends: 0, hashes: [], failNext: false, failSignNext: false };
    const executed = await runRewardRefund(
      { refundId: begun.refund_id as string, campaignId: campaign.settlementId },
      makeDependencies(probe),
    );
    expect(executed.kind).toBe("broadcasted");
    expect(probe.sends).toBe(1);
    const confirmed = await confirmRefund(
      begun.refund_id as string, campaign.settlementId,
      executed.kind === "broadcasted" ? executed.transactionHash : "",
    );
    expect(confirmed.result_kind).toBe("confirmed");

    const { data: receipt } = await admin.from("reward_receipts")
      .select("status, amount_luna").eq("id", receiptId).single();
    expect(receipt).toMatchObject({ status: "paid", amount_luna: 50000 });
    const settled = await readSettlement(campaign.settlementId);
    expect(settled.status).toBe("refunded");
    expect(Number(settled.paid_amount_luna)).toBe(50000);
  });
});
