import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { KeyPair, Signature, Transaction } from "@nimiq/core";
import { createParticipationCampaign, publishParticipationCampaign } from "@/lib/campaigns/configuration";
import { beginCampaignFunding, bindCampaignFunding } from "@/lib/campaigns/funding";
import { deriveAddressFromPublicKey } from "@/lib/nimiq/server-crypto";
import { ensureRewardSettlementVault, withRewardSettlementVaultKey } from "@/lib/rewards/vault-service";
import {
  buildRewardPayoutTransaction,
  signRewardPayoutTransaction,
} from "@/lib/rewards/vault-signing";
import {
  createDefaultFundingConfirmationDependencies,
  loadFundingConfirmationContext,
  reconcileFundingIntent,
} from "@/lib/rewards/funding-confirmation";
import type { FundingObservation } from "@/lib/rewards/reconciliation";
import {
  createSupabaseRewardPayoutStore,
  runRewardPayout,
  type PayoutDependencies,
} from "@/lib/rewards/payout";
import {
  createSupabaseRewardRefundStore,
  runRewardRefund,
  type RefundDependencies,
} from "@/lib/rewards/refund";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import { testDbContainer, testSupabaseKey, testSupabaseUrl } from "@/lib/rewards/test-target";

const mocks = vi.hoisted(() => ({
  session: null as { address: string } | null,
  payoutSends: 0,
  refundSends: 0,
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/api/origin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/origin")>();
  return { ...actual, isSameOriginRequest: () => true };
});

// Payout handoff inside the claims route is counted, not executed: the real
// engine runs explicitly below with stubbed transport (D6 model). This also
// proves the handoff fires exactly once per successful claim path.
vi.mock("@/lib/rewards/settlement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rewards/settlement")>();
  return {
    ...actual,
    createRewardSettlementService: (admin: unknown) => ({
      ...(actual.createRewardSettlementService(admin as never) as unknown as Record<string, unknown>),
      executePayout: async () => {
        mocks.payoutSends += 1;
        return { kind: "broadcasted", attemptId: "handoff", transactionHash: "handoff" };
      },
    }),
  };
});

import { POST as challengeRoute } from "@/app/api/campaigns/[campaignId]/claims/challenge/route";
import { POST as claimRoute } from "@/app/api/campaigns/[campaignId]/claims/route";
import { POST as closeRoute } from "@/app/api/campaigns/[campaignId]/close/route";

const url = testSupabaseUrl();
const key = testSupabaseKey();
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const NETWORK_ID = 24;
const createdCampaignIds: string[] = [];
const createdRootIds: string[] = [];

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function envelopeHash(message: string): Uint8Array {
  const prefix = `${String.fromCharCode(0x16)}Nimiq Signed Message:\n`;
  const payload = Buffer.concat([
    Buffer.from(prefix, "utf8"),
    Buffer.from(String(message.length), "utf8"),
    Buffer.from(message, "utf8"),
  ]);
  return new Uint8Array(createHash("sha256").update(payload).digest());
}

function freshWallet() {
  const keypair = KeyPair.generate();
  const publicKey = keypair.publicKey.toHex();
  const address = deriveAddressFromPublicKey(publicKey);
  if (!address) throw new Error("keypair fixture invalid");
  return {
    address,
    publicKey,
    sign: (message: string) => Signature.create(keypair.privateKey, keypair.publicKey, envelopeHash(message)).toHex(),
  };
}

function runPsql(sql: string): void {
  execFileSync("docker", [
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-c", sql,
  ], { stdio: "pipe" });
}

function routeContext(campaignId: string) {
  return { params: Promise.resolve({ campaignId }) };
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function stubBroadcast(probe: { sends: number }) {
  return async (serializedTransactionHex: string) => {
    const tx = Transaction.deserialize(Buffer.from(serializedTransactionHex, "hex"));
    try {
      probe.sends += 1;
      return { kind: "broadcast" as const, transactionHash: tx.hash() };
    } finally {
      tx.free?.();
    }
  };
}

function payoutDeps(probe: { sends: number }): PayoutDependencies {
  return {
    store: createSupabaseRewardPayoutStore(admin as never),
    createLockToken: randomUUID,
    sign: async (context) => withRewardSettlementVaultKey(context.campaignId, (keypair) => {
      const built = buildRewardPayoutTransaction({
        senderAddressHex: context.senderAddressHex,
        recipientAddressHex: context.recipientAddressHex,
        rewardPerParticipantLuna: context.amountLuna,
        feeLuna: context.feeLuna,
        validityStartHeight: context.validityStartHeight,
        networkId: context.networkId,
      });
      const signed = signRewardPayoutTransaction(built, keypair);
      return { ...context, serializedTransactionHex: signed.toHex(), transactionHash: signed.hash() };
    }),
    broadcast: stubBroadcast(probe),
    getNetworkId: () => NETWORK_ID,
    getValidityStartHeight: async () => 100,
    sleep: async () => {},
  };
}

function refundDeps(probe: { sends: number }): RefundDependencies {
  return {
    store: createSupabaseRewardRefundStore(admin as never),
    createLockToken: randomUUID,
    sign: async (context) => withRewardSettlementVaultKey(context.campaignId, (keypair) => {
      const built = buildRewardPayoutTransaction({
        senderAddressHex: context.senderAddressHex,
        recipientAddressHex: context.recipientAddressHex,
        rewardPerParticipantLuna: context.amountLuna,
        feeLuna: context.feeLuna,
        validityStartHeight: context.validityStartHeight,
        networkId: context.networkId,
      });
      const signed = signRewardPayoutTransaction(built, keypair);
      return { ...context, serializedTransactionHex: signed.toHex(), transactionHash: signed.hash() };
    }),
    broadcast: stubBroadcast(probe),
    getNetworkId: () => NETWORK_ID,
    getFeeLuna: () => BigInt(1000),
    getValidityStartHeight: async () => 100,
    sleep: async () => {},
  };
}

function observedFunding(owner: string, hash: string, vaultHex: string, amountLuna: bigint, reference: string): FundingObservation {
  const block = hex(32);
  return {
    kind: "found",
    transaction: {
      transactionHash: hash,
      blockHash: block,
      networkId: NETWORK_ID,
      sender: owner,
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

async function setupCampaign(owner: string, maxParticipants: number, endsAt: string | null = null) {
  const result = await createParticipationCampaign(owner, {
    type: "public_giveaway",
    title: `E2E fixture ${randomUUID()}`,
    description: null,
    visibility: "public",
    startsAt: null,
    endsAt,
    rewardPerParticipant: "0.5",
    maxRewardedParticipants: maxParticipants,
    fundingMode: "creator",
  });
  createdCampaignIds.push(result.campaign.campaignId);
  createdRootIds.push(result.campaign.settlementId);
  const campaign = result.campaign;

  await ensureRewardSettlementVault(campaign.settlementId);

  // Publish precedes funding: the publish RPC requires a configured root.
  await publishParticipationCampaign(owner, campaign.campaignId);

  // Real funding path: begin + bind + confirm with stubbed observation.
  // The funding sender is the creator (funding_mode creator).
  mocks.session = { address: owner };
  const started = await beginCampaignFunding(admin as never, campaign.campaignId, owner);
  if (started.kind !== "created") throw new Error(`fund begin failed: ${started.kind}`);
  const txHash = hex(32);
  const bound = await bindCampaignFunding(
    admin as never, campaign.campaignId, started.fundingIntent.fundingIntentId, owner, txHash,
  );
  if (bound.kind !== "bound") throw new Error(`fund bind failed: ${bound.kind}`);
  const loaded = await loadFundingConfirmationContext(
    admin as never, campaign.settlementId, started.fundingIntent.fundingIntentId, owner,
  );
  if (loaded.kind !== "ok") throw new Error("fund context not loadable");
  const deps = createDefaultFundingConfirmationDependencies(admin as never);
  const confirmed = await reconcileFundingIntent(loaded.context, {
    ...deps,
    observeFundingByHash: async () => observedFunding(
      owner, txHash, started.fundingIntent.vaultAddressHex, BigInt(started.fundingIntent.requiredFundingLuna), started.fundingIntent.reference,
    ),
  });
  if (confirmed.kind !== "confirmed") throw new Error(`fund confirm failed: ${confirmed.kind}`);

  mocks.session = null;
  return campaign;
}

async function httpChallenge(campaignId: string, wallet: { address: string }) {
  mocks.session = { address: wallet.address };
  const response = await challengeRoute(
    jsonRequest(`/api/campaigns/${campaignId}/claims/challenge`, {}),
    routeContext(campaignId),
  );
  mocks.session = null;
  return response;
}

async function httpClaim(
  campaignId: string,
  wallet: { address: string; publicKey: string; sign: (message: string) => string },
  challenge: { challengeId: string; message: string },
) {
  mocks.session = { address: wallet.address };
  const response = await claimRoute(
    jsonRequest(`/api/campaigns/${campaignId}/claims`, {
      challengeId: challenge.challengeId,
      address: wallet.address,
      publicKey: wallet.publicKey,
      signature: wallet.sign(challenge.message),
    }),
    routeContext(campaignId),
  );
  mocks.session = null;
  return response;
}

async function httpClose(campaignId: string, owner: { address: string }) {
  mocks.session = { address: owner.address };
  const response = await closeRoute(
    jsonRequest(`/api/campaigns/${campaignId}/close`, {}),
    routeContext(campaignId),
  );
  mocks.session = null;
  return response;
}

async function confirmPayout(receiptId: string, settlementId: string, transactionHash: string) {
  const { data: receipt } = await admin.from("reward_receipts")
    .select("participant_wallet, amount_luna").eq("id", receiptId).single();
  const { data: vault } = await admin.from("reward_campaign_vaults")
    .select("vault_address_hex").eq("settlement_id", settlementId).single();
  const block = hex(32);
  const { data, error } = await admin.rpc("confirm_reward_payout_atomic", {
    _attempt_id: (await admin.from("reward_payout_attempts").select("id").eq("receipt_id", receiptId).single()).data?.id,
    _receipt_id: receiptId,
    _campaign_id: settlementId,
    _transaction_hash: transactionHash,
    _network_id: NETWORK_ID,
    _observed_sender: vault?.vault_address_hex as string,
    _observed_recipient: receipt?.participant_wallet as string,
    _observed_amount_luna: Number(receipt?.amount_luna),
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

async function confirmRefund(refundId: string, settlementId: string, transactionHash: string) {
  const { data: refund } = await admin.from("reward_refunds")
    .select("creator_wallet, amount_luna").eq("id", refundId).single();
  const { data: vault } = await admin.from("reward_campaign_vaults")
    .select("vault_address_hex").eq("settlement_id", settlementId).single();
  const block = hex(32);
  const { data, error } = await admin.rpc("confirm_reward_refund_atomic", {
    _refund_id: refundId,
    _campaign_id: settlementId,
    _transaction_hash: transactionHash,
    _network_id: NETWORK_ID,
    _observed_sender: vault?.vault_address_hex as string,
    _observed_recipient: refund?.creator_wallet as string,
    _observed_amount_luna: Number(refund?.amount_luna),
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

async function readSettlement(settlementId: string) {
  const { data, error } = await admin.from("reward_settlements")
    .select("status, rewarded_participant_count, paid_amount_luna, fee_spent_luna, refundable_amount_luna, refundable_excess_luna, reward_principal_luna, fee_reserve_luna, funded_amount_luna, total_budget_luna, first_reservation_at, refunded_at, closed_at")
    .eq("id", settlementId)
    .single();
  if (error || !data) throw error ?? new Error("settlement fixture missing");
  return data;
}

async function readReceipts(settlementId: string) {
  const { data, error } = await admin.from("reward_receipts")
    .select("id, campaign_id, poll_id, settlement_id, participant_wallet, amount_luna, status")
    .eq("settlement_id", settlementId);
  if (error) throw error;
  return data ?? [];
}

async function readRefunds(settlementId: string) {
  const { data, error } = await admin.from("reward_refunds")
    .select("id, campaign_id, settlement_id, creator_wallet, amount_luna, status, transaction_hash")
    .eq("settlement_id", settlementId);
  if (error) throw error;
  return data ?? [];
}

function assertConservation(settled: Record<string, unknown>, label: string) {
  const paid = BigInt(settled.paid_amount_luna as string);
  const feeSpent = BigInt(settled.fee_spent_luna as string);
  const refundable = BigInt(settled.refundable_amount_luna as string);
  const funded = BigInt(settled.funded_amount_luna as string);
  expect(paid + feeSpent + refundable <= funded, label).toBe(true);
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

describe("V2C.3 public giveaway vertical slice", () => {
  it("lifecycle 1: fund, claim, payout, close, refund remainder to terminal", async () => {
    const creator = freshWallet();
    const participant = freshWallet();
    const payoutProbe = { sends: 0 };
    const refundProbe = { sends: 0 };
    mocks.payoutSends = 0;

    const campaign = await setupCampaign(creator.address, 4);

    const challengeResponse = await httpChallenge(campaign.campaignId, participant);
    expect(challengeResponse.status).toBe(201);
    const challenge = await challengeResponse.json();

    const claimResponse = await httpClaim(campaign.campaignId, participant, challenge);
    expect(claimResponse.status).toBe(201);
    const claimBody = await claimResponse.json();
    expect(claimBody).toMatchObject({ settlementId: campaign.settlementId, replayed: false });
    const receiptId = claimBody.receiptId as string;
    expect(mocks.payoutSends).toBe(1);

    const payout = await runRewardPayout(
      { receiptId, campaignId: campaign.settlementId }, payoutDeps(payoutProbe),
    );
    expect(payout.kind).toBe("broadcasted");
    if (payout.kind !== "broadcasted") throw new Error("expected payout broadcast");
    expect(payoutProbe.sends).toBe(1);
    const paid = await confirmPayout(receiptId, campaign.settlementId, payout.transactionHash);
    expect(paid.result_kind).toBe("confirmed");

    const closeResponse = await httpClose(campaign.campaignId, creator);
    expect(closeResponse.status).toBe(200);

    // Owner session binding lives in wallet_sessions; the claim-time stub
    // above is replaced by a real owner row for the refund path.
    const ownerToken = hex(32);
    await admin.from("wallet_sessions").insert({
      token_hash: ownerToken,
      wallet_address: creator.address,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      revoked_at: null,
    });
    const { data: refundBegun, error: refundError } = await admin.rpc("begin_campaign_refund_atomic", {
      _settlement_id: campaign.settlementId,
      _session_token_hash: ownerToken,
    });
    expect(refundError).toBeNull();
    expect((refundBegun as Record<string, unknown>).result_kind).toBe("created");
    const refundId = (refundBegun as Record<string, unknown>).refund_id as string;

    const refunded = await runRewardRefund(
      { refundId, campaignId: campaign.settlementId }, refundDeps(refundProbe),
    );
    expect(refunded.kind).toBe("broadcasted");
    expect(refundProbe.sends).toBe(1);
    const refundRow = await admin.from("reward_refunds").select("transaction_hash").eq("id", refundId).single();
    const refundConfirmed = await confirmRefund(refundId, campaign.settlementId, refundRow.data?.transaction_hash as string);
    expect(refundConfirmed.result_kind).toBe("confirmed");

    const receipts = await readReceipts(campaign.settlementId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      campaign_id: null, poll_id: null, participant_wallet: participant.address, status: "paid",
    });
    const settled = await readSettlement(campaign.settlementId);
    expect(settled.status).toBe("refunded");
    expect(Number(settled.rewarded_participant_count)).toBe(1);
    expect(Number(settled.paid_amount_luna)).toBe(Number(receipts[0].amount_luna));
    const refunds = await readRefunds(campaign.settlementId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].creator_wallet).toBe(creator.address);
    expect(
      Number(settled.paid_amount_luna) + Number(settled.fee_spent_luna) + Number(refunds[0].amount_luna)
      <= Number(settled.funded_amount_luna),
    ).toBe(true);
    assertConservation(settled as Record<string, unknown>, "lifecycle 1 conservation");
    await admin.from("wallet_sessions").delete().eq("token_hash", ownerToken);
  });

  it("lifecycle 2: no claims refunds the full remainder with no payout activity", async () => {
    const creator = freshWallet();
    const campaign = await setupCampaign(creator.address, 2);
    await httpClose(campaign.campaignId, creator);

    const ownerToken = hex(32);
    await admin.from("wallet_sessions").insert({
      token_hash: ownerToken,
      wallet_address: creator.address,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      revoked_at: null,
    });
    const { data: begun, error } = await admin.rpc("begin_campaign_refund_atomic", {
      _settlement_id: campaign.settlementId,
      _session_token_hash: ownerToken,
    });
    expect(error).toBeNull();
    expect((begun as Record<string, unknown>).result_kind).toBe("created");
    const economics = await readSettlement(campaign.settlementId);
    const expected = BigInt(economics.reward_principal_luna as string)
      + BigInt(economics.fee_reserve_luna as string)
      + BigInt(economics.refundable_excess_luna as string);
    expect(String((begun as Record<string, unknown>).amount_luna)).toBe(String(expected));

    const refundProbe = { sends: 0 };
    const refundId = (begun as Record<string, unknown>).refund_id as string;
    const executed = await runRewardRefund(
      { refundId, campaignId: campaign.settlementId }, refundDeps(refundProbe),
    );
    expect(executed.kind).toBe("broadcasted");
    const row = await admin.from("reward_refunds").select("transaction_hash").eq("id", refundId).single();
    const confirmed = await confirmRefund(refundId, campaign.settlementId, row.data?.transaction_hash as string);
    expect(confirmed.result_kind).toBe("confirmed");

    expect(await readReceipts(campaign.settlementId)).toHaveLength(0);
    const settled = await readSettlement(campaign.settlementId);
    expect(settled.status).toBe("refunded");
    expect(Number(settled.rewarded_participant_count)).toBe(0);
    expect(Number(settled.paid_amount_luna)).toBe(0);
    assertConservation(settled as Record<string, unknown>, "lifecycle 2 conservation");
    await admin.from("wallet_sessions").delete().eq("token_hash", ownerToken);
  });

  it("lifecycle 3: capacity fills exactly then refund honors paid remainder", async () => {
    const creator = freshWallet();
    const campaign = await setupCampaign(creator.address, 2);
    const first = freshWallet();
    const second = freshWallet();
    const third = freshWallet();

    for (const participant of [first, second]) {
      const challengeResponse = await httpChallenge(campaign.campaignId, participant);
      expect(challengeResponse.status).toBe(201);
      const challenge = await challengeResponse.json();
      const claimResponse = await httpClaim(campaign.campaignId, participant, challenge);
      expect(claimResponse.status).toBe(201);
    }
    const receipts = await readReceipts(campaign.settlementId);
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((row) => row.participant_wallet as string)).size).toBe(2);

    const loserChallengeResponse = await httpChallenge(campaign.campaignId, third);
    expect(loserChallengeResponse.status).toBe(201);
    const loserChallenge = await loserChallengeResponse.json();
    const loserClaim = await httpClaim(campaign.campaignId, third, loserChallenge);
    expect(loserClaim.status).toBe(409);
    expect((await loserClaim.json()).reasonCode).toBe("sold_out");

    const settled = await readSettlement(campaign.settlementId);
    expect(Number(settled.rewarded_participant_count)).toBe(2);
    expect((await readReceipts(campaign.settlementId))).toHaveLength(2);

    // Pay both obligations through the real engine, then close and refund.
    const payoutProbe = { sends: 0 };
    for (const row of receipts) {
      const payout = await runRewardPayout(
        { receiptId: row.id as string, campaignId: campaign.settlementId }, payoutDeps(payoutProbe),
      );
      expect(payout.kind).toBe("broadcasted");
      if (payout.kind !== "broadcasted") throw new Error("expected payout broadcast");
      const paid = await confirmPayout(row.id as string, campaign.settlementId, payout.transactionHash);
      expect(paid.result_kind).toBe("confirmed");
    }
    expect(payoutProbe.sends).toBe(2);
    await httpClose(campaign.campaignId, creator);

    const ownerToken = hex(32);
    await admin.from("wallet_sessions").insert({
      token_hash: ownerToken,
      wallet_address: creator.address,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      revoked_at: null,
    });
    const { data: begun } = await admin.rpc("begin_campaign_refund_atomic", {
      _settlement_id: campaign.settlementId,
      _session_token_hash: ownerToken,
    });
    expect((begun as Record<string, unknown>).result_kind).toBe("created");
    const afterBegin = await readSettlement(campaign.settlementId);
    const expected = BigInt(afterBegin.funded_amount_luna as string)
      - BigInt(afterBegin.paid_amount_luna as string)
      - BigInt(afterBegin.fee_spent_luna as string);
    expect(String((begun as Record<string, unknown>).amount_luna)).toBe(String(expected));
    await admin.from("wallet_sessions").delete().eq("token_hash", ownerToken);
  });

  it("lifecycle 4: fresh claim after close is deterministically rejected", async () => {
    const creator = freshWallet();
    const participant = freshWallet();
    const campaign = await setupCampaign(creator.address, 2);

    // Challenge issued while open, claimed after close: the atomic path
    // reports campaign_closed and consumes nothing.
    const openChallengeResponse = await httpChallenge(campaign.campaignId, participant);
    expect(openChallengeResponse.status).toBe(201);
    const openChallenge = await openChallengeResponse.json();
    await httpClose(campaign.campaignId, creator);

    const claimResponse = await httpClaim(campaign.campaignId, participant, openChallenge);
    expect(claimResponse.status).toBe(422);
    // Courtesy-layer code for a non-published campaign; the atomic RPC
    // reports the deterministic campaign_closed underneath (proven in the
    // F1 close suites).
    expect(await claimResponse.json()).toMatchObject({
      error: "claim_not_available",
      reasonCode: "campaign_not_published",
    });

    // Challenge issuance itself is already screened once closed.
    const challengeResponse = await httpChallenge(campaign.campaignId, participant);
    expect(challengeResponse.status).toBe(422);

    expect(await readReceipts(campaign.settlementId)).toHaveLength(0);
    const settled = await readSettlement(campaign.settlementId);
    expect(Number(settled.rewarded_participant_count)).toBe(0);
    expect(settled.first_reservation_at).toBeNull();
    const { data: stored } = await admin.from("campaign_claim_challenges")
      .select("consumed_at").eq("id", openChallenge.challengeId).single();
    expect(stored?.consumed_at).toBeNull();
  });

  it("lifecycle 5: unresolved payout blocks refund until canonically resolved", async () => {
    const creator = freshWallet();
    const participant = freshWallet();
    const campaign = await setupCampaign(creator.address, 2);

    const challengeResponse = await httpChallenge(campaign.campaignId, participant);
    const challenge = await challengeResponse.json();
    const claimResponse = await httpClaim(campaign.campaignId, participant, challenge);
    expect(claimResponse.status).toBe(201);
    const receiptId = ((await claimResponse.json()) as Record<string, unknown>).receiptId as string;

    await httpClose(campaign.campaignId, creator);

    const payoutProbe = { sends: 0 };
    const begun = await runRewardPayout(
      { receiptId, campaignId: campaign.settlementId }, payoutDeps(payoutProbe),
    );
    expect(begun.kind).toBe("broadcasted");

    const ownerToken = hex(32);
    await admin.from("wallet_sessions").insert({
      token_hash: ownerToken,
      wallet_address: creator.address,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      revoked_at: null,
    });
    const { data: blocked } = await admin.rpc("begin_campaign_refund_atomic", {
      _settlement_id: campaign.settlementId,
      _session_token_hash: ownerToken,
    });
    // The broadcast attempt carries hash-bearing evidence, so the engine
    // reports reconciliation-required (higher precedence than plain
    // unresolved); either way no intent exists and nothing is refunded.
    expect((blocked as Record<string, unknown>).result_kind).toBe("payout_reconciliation_required");
    expect(await readRefunds(campaign.settlementId)).toHaveLength(0);

    // Resolve canonically: the pending attempt is already broadcast-marked
    // by the engine run above, so confirm it directly.
    const { data: attempt } = await admin.from("reward_payout_attempts")
      .select("transaction_hash").eq("receipt_id", receiptId).single();
    const paid = await confirmPayout(receiptId, campaign.settlementId, attempt?.transaction_hash as string);
    expect(paid.result_kind).toBe("confirmed");

    const { data: allowed } = await admin.rpc("begin_campaign_refund_atomic", {
      _settlement_id: campaign.settlementId,
      _session_token_hash: ownerToken,
    });
    expect((allowed as Record<string, unknown>).result_kind).toBe("created");
    const settled = await readSettlement(campaign.settlementId);
    const { data: receipt } = await admin.from("reward_receipts")
      .select("amount_luna").eq("id", receiptId).single();
    expect(
      Number((allowed as Record<string, unknown>).amount_luna)
      + Number(receipt?.amount_luna),
    ).toBeLessThanOrEqual(Number(settled.funded_amount_luna));
    await admin.from("wallet_sessions").delete().eq("token_hash", ownerToken);
  });

  it("lifecycle 6: retries stay idempotent across every boundary", async () => {
    const creator = freshWallet();
    const participant = freshWallet();
    const payoutProbe = { sends: 0 };
    const refundProbe = { sends: 0 };
    mocks.payoutSends = 0;

    const campaign = await setupCampaign(creator.address, 2);

    const challengeResponse = await httpChallenge(campaign.campaignId, participant);
    const challenge = await challengeResponse.json();
    const body = {
      challengeId: challenge.challengeId,
      address: participant.address,
      publicKey: participant.publicKey,
      signature: participant.sign(challenge.message),
    };
    mocks.session = { address: participant.address };
    const first = await claimRoute(
      jsonRequest(`/api/campaigns/${campaign.campaignId}/claims`, body),
      routeContext(campaign.campaignId),
    );
    const retry = await claimRoute(
      jsonRequest(`/api/campaigns/${campaign.campaignId}/claims`, body),
      routeContext(campaign.campaignId),
    );
    mocks.session = null;
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    const firstBody = await first.json();
    const retryBody = await retry.json();
    expect(retryBody).toMatchObject({ receiptId: firstBody.receiptId, replayed: true });
    expect(await readReceipts(campaign.settlementId)).toHaveLength(1);

    mocks.session = { address: creator.address };
    const closeFirst = await closeRoute(
      jsonRequest(`/api/campaigns/${campaign.campaignId}/close`, {}),
      routeContext(campaign.campaignId),
    );
    const closeRetry = await closeRoute(
      jsonRequest(`/api/campaigns/${campaign.campaignId}/close`, {}),
      routeContext(campaign.campaignId),
    );
    mocks.session = null;
    expect(closeFirst.status).toBe(200);
    expect(closeRetry.status).toBe(200);

    const payout = await runRewardPayout(
      { receiptId: firstBody.receiptId as string, campaignId: campaign.settlementId },
      payoutDeps(payoutProbe),
    );
    expect(payout.kind).toBe("broadcasted");
    const payoutRetry = await runRewardPayout(
      { receiptId: firstBody.receiptId as string, campaignId: campaign.settlementId },
      payoutDeps(payoutProbe),
    );
    expect(payoutRetry.kind).toBe("already_pending");
    expect(payoutProbe.sends).toBe(1);
    await confirmPayout(firstBody.receiptId as string, campaign.settlementId,
      payout.kind === "broadcasted" ? payout.transactionHash : "");

    const ownerToken = hex(32);
    await admin.from("wallet_sessions").insert({
      token_hash: ownerToken,
      wallet_address: creator.address,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      revoked_at: null,
    });
    const { data: begun } = await admin.rpc("begin_campaign_refund_atomic", {
      _settlement_id: campaign.settlementId,
      _session_token_hash: ownerToken,
    });
    const refundId = (begun as Record<string, unknown>).refund_id as string;
    const { data: begunAgain } = await admin.rpc("begin_campaign_refund_atomic", {
      _settlement_id: campaign.settlementId,
      _session_token_hash: ownerToken,
    });
    expect((begunAgain as Record<string, unknown>).refund_id).toBe(refundId);

    const refunded = await runRewardRefund(
      { refundId, campaignId: campaign.settlementId }, refundDeps(refundProbe),
    );
    expect(refunded.kind).toBe("broadcasted");
    const refundedAgain = await runRewardRefund(
      { refundId, campaignId: campaign.settlementId }, refundDeps(refundProbe),
    );
    expect(refundedAgain.kind).toBe("already_pending");
    expect(refundProbe.sends).toBe(1);

    const refundRow = await admin.from("reward_refunds").select("transaction_hash").eq("id", refundId).single();
    await confirmRefund(refundId, campaign.settlementId, refundRow.data?.transaction_hash as string);
    expect((await readSettlement(campaign.settlementId)).status).toBe("refunded");
    expect(await readRefunds(campaign.settlementId)).toHaveLength(1);
    await admin.from("wallet_sessions").delete().eq("token_hash", ownerToken);
  });

  it("authority boundaries hold end to end", async () => {
    const creator = freshWallet();
    const participant = freshWallet();
    const stranger = freshWallet();
    const campaign = await setupCampaign(creator.address, 2);

    // Non-owner close cannot mutate.
    mocks.session = { address: stranger.address };
    const forbidden = await closeRoute(
      jsonRequest(`/api/campaigns/${campaign.campaignId}/close`, {}),
      routeContext(campaign.campaignId),
    );
    mocks.session = null;
    expect(forbidden.status).toBe(403);

    // Forged signature cannot mutate.
    const challengeResponse = await httpChallenge(campaign.campaignId, participant);
    const challenge = await challengeResponse.json();
    mocks.session = { address: participant.address };
    const forged = await claimRoute(
      jsonRequest(`/api/campaigns/${campaign.campaignId}/claims`, {
        challengeId: challenge.challengeId,
        address: participant.address,
        publicKey: participant.publicKey,
        signature: stranger.sign(challenge.message),
      }),
      routeContext(campaign.campaignId),
    );
    mocks.session = null;
    expect(forged.status).toBe(422);
    expect(await readReceipts(campaign.settlementId)).toHaveLength(0);

    // Forged economics in every body are ignored.
    const honest = await httpClaim(campaign.campaignId, participant, challenge);
    expect(honest.status).toBe(201);
    const honestBody = await honest.json();
    expect(Object.keys(honestBody).sort()).toEqual(
      ["receiptId", "replayed", "settlementId", "status"],
    );
    expect(honestBody.settlementId).toBe(campaign.settlementId);
  });
});
