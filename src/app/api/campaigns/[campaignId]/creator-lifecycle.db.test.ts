import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { KeyPair, Signature, Transaction } from "@nimiq/core";
import { deriveAddressFromPublicKey } from "@/lib/nimiq/server-crypto";
import { ensureRewardSettlementVault, withRewardSettlementVaultKey } from "@/lib/rewards/vault-service";
import {
  buildRewardPayoutTransaction,
  signRewardPayoutTransaction,
} from "@/lib/rewards/vault-signing";
import {
  createSupabaseRewardPayoutStore,
  runRewardPayout,
  type PayoutDependencies,
} from "@/lib/rewards/payout";
import type { FundingObservation } from "@/lib/rewards/reconciliation";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import { testDbContainer, testSupabaseKey, testSupabaseUrl } from "@/lib/rewards/test-target";

const mocks = vi.hoisted(() => ({
  session: null as { address: string; tokenHash: string } | null,
  payoutHandoffs: 0,
  refundSends: 0,
  fundingObservation: null as null | ((hash: string) => Promise<FundingObservation>),
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => Promise.resolve(mocks.session),
}));

vi.mock("@/lib/api/origin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/origin")>();
  return { ...actual, isSameOriginRequest: () => true };
});

// Claim-time payout handoff is counted, never executed: receipts stay
// reserved until the test settles them explicitly with runRewardPayout.
vi.mock("@/lib/rewards/settlement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rewards/settlement")>();
  return {
    ...actual,
    createRewardSettlementService: (admin: unknown) => ({
      ...(actual.createRewardSettlementService(admin as never) as unknown as Record<string, unknown>),
      executePayout: async () => {
        mocks.payoutHandoffs += 1;
        return { kind: "broadcasted", attemptId: "handoff", transactionHash: "handoff" };
      },
    }),
  };
});

// Chain observation boundary: funding confirmation observes a fixture
// matching the bound server terms. No network contact.
vi.mock("@/lib/nimiq/observation", () => ({
  createNimiqTransactionObservationAdapter: () => ({
    observeFundingByHash: (hash: string) => {
      if (!mocks.fundingObservation) throw new Error("observation fixture missing");
      return mocks.fundingObservation(hash);
    },
  }),
}));

// Chain broadcast boundary: the real engine-built bytes are deserialized
// locally and counted. No network contact, no NIM movement.
vi.mock("@/lib/nimiq/broadcast", () => ({
  createNimiqBroadcastAdapter: () => ({
    getBlockNumber: async () => 100,
    broadcastTransaction: async (serializedTransactionHex: string) => {
      const tx = Transaction.deserialize(Buffer.from(serializedTransactionHex, "hex"));
      try {
        mocks.refundSends += 1;
        return { kind: "broadcast" as const, transactionHash: tx.hash() };
      } finally {
        tx.free?.();
      }
    },
  }),
}));

import { POST as createRoute } from "@/app/api/campaigns/route";
import { GET as readinessRoute } from "@/app/api/campaigns/[campaignId]/funding-readiness/route";
import { POST as intentRoute } from "@/app/api/campaigns/[campaignId]/funding/intents/route";
import { POST as bindRoute } from "@/app/api/campaigns/[campaignId]/funding/intents/[intentId]/bind/route";
import { POST as confirmRoute } from "@/app/api/campaigns/[campaignId]/funding/intents/[intentId]/confirm/route";
import { POST as publishRoute } from "@/app/api/campaigns/[campaignId]/publish/route";
import { GET as publicRoute } from "@/app/api/campaigns/[campaignId]/public/route";
import { POST as closeRoute } from "@/app/api/campaigns/[campaignId]/close/route";
import { POST as refundRoute } from "@/app/api/campaigns/[campaignId]/refund/route";
import { POST as challengeRoute } from "@/app/api/campaigns/[campaignId]/claims/challenge/route";
import { POST as claimRoute } from "@/app/api/campaigns/[campaignId]/claims/route";

const url = testSupabaseUrl();
const key = testSupabaseKey();
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const NETWORK_ID = 24;
const createdCampaignIds: string[] = [];
const createdRootIds: string[] = [];
const createdTokenHashes: string[] = [];

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

function ctx<T extends Record<string, string>>(
  campaignId: string,
  extra?: T,
): { params: Promise<{ campaignId: string } & T> } {
  return {
    params: Promise.resolve({ campaignId, ...extra }) as unknown as Promise<{ campaignId: string } & T>,
  };
}

function jsonPost(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return new Request(`http://localhost${path}`, { method: "GET" });
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

function payoutDeps(): PayoutDependencies {
  return {
    store: createSupabaseRewardPayoutStore(admin as never),
    createLockToken: randomUUID,
    sign: (context) => withRewardSettlementVaultKey(context.campaignId, (keypair) => {
      const built = buildRewardPayoutTransaction({
        senderAddressHex: context.senderAddressHex,
        recipientAddressHex: context.recipientAddressHex,
        rewardPerParticipantLuna: context.amountLuna,
        feeLuna: context.feeLuna,
        validityStartHeight: context.validityStartHeight,
        networkId: context.networkId,
      });
      const signed = signRewardPayoutTransaction(built, keypair);
      return Promise.resolve({ ...context, serializedTransactionHex: signed.toHex(), transactionHash: signed.hash() });
    }),
    broadcast: async (serializedTransactionHex) => {
      const tx = Transaction.deserialize(Buffer.from(serializedTransactionHex, "hex"));
      try {
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

async function ownerSessionToken(owner: string): Promise<string> {
  const tokenHash = hex(32);
  const { error } = await admin.from("wallet_sessions").insert({
    token_hash: tokenHash,
    wallet_address: owner,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    revoked_at: null,
  });
  if (error) throw error;
  createdTokenHashes.push(tokenHash);
  return tokenHash;
}

async function confirmRefundRpc(refundId: string, settlementId: string, transactionHash: string) {
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

async function confirmPayoutRpc(receiptId: string, settlementId: string, transactionHash: string) {
  const { data: receipt } = await admin.from("reward_receipts")
    .select("participant_wallet, amount_luna").eq("id", receiptId).single();
  const { data: vault } = await admin.from("reward_campaign_vaults")
    .select("vault_address_hex").eq("settlement_id", settlementId).single();
  const block = hex(32);
  const attemptId = (await admin.from("reward_payout_attempts").select("id").eq("receipt_id", receiptId).single()).data?.id;
  const { data, error } = await admin.rpc("confirm_reward_payout_atomic", {
    _attempt_id: attemptId,
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

describe("C6 creator lifecycle integration proof", () => {
  it("create → fund → publish → public → close → refund → terminal", async () => {
    const creator = freshWallet();
    const ownerToken = await ownerSessionToken(creator.address);
    mocks.session = { address: creator.address, tokenHash: ownerToken };

    // 1. Create draft through the real route. Forged authority is rejected;
    // identity comes only from the session.
    const forged = await createRoute(
      jsonPost("/api/campaigns", {
        type: "public_giveaway",
        title: "C6 lifecycle proof",
        description: null,
        visibility: "public",
        startsAt: null,
        endsAt: null,
        rewardPerParticipant: "0.5",
        maxRewardedParticipants: 10,
        fundingMode: "creator",
        ownerWallet: creator.address,
        settlementId: "forged",
      }),
    );
    expect(forged.status).toBe(400);
    const createResponse = await createRoute(
      jsonPost("/api/campaigns", {
        type: "public_giveaway",
        title: "C6 lifecycle proof",
        description: null,
        visibility: "public",
        startsAt: null,
        endsAt: null,
        rewardPerParticipant: "0.5",
        maxRewardedParticipants: 10,
        fundingMode: "creator",
      }),
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const campaignId = created.campaign.campaignId as string;
    createdCampaignIds.push(campaignId);
    expect(JSON.stringify(created)).not.toMatch(/owner_wallet|settlement_id|vault/i);

    // Non-owner lifecycle writes are forbidden.
    const stranger = freshWallet();
    mocks.session = { address: stranger.address, tokenHash: hex(32) };
    const forbiddenClose = await closeRoute(jsonPost(`/api/campaigns/${campaignId}/close`, {}), ctx(campaignId));
    expect(forbiddenClose.status).toBe(403);
    mocks.session = { address: creator.address, tokenHash: ownerToken };

    // 2. Readiness is server-derived: vault missing first, then provisioned.
    const notReady = await (await readinessRoute(get(`/api/campaigns/${campaignId}/funding-readiness`), ctx(campaignId))).json();
    expect(notReady.fundingReadiness).toMatchObject({ ready: false, reason: "vault_not_ready" });
    const { data: campaignRow } = await admin.from("participation_campaigns")
      .select("settlement_id").eq("id", campaignId).single();
    const settlementId = campaignRow?.settlement_id as string;
    createdRootIds.push(settlementId);
    await ensureRewardSettlementVault(settlementId);
    const readyForFunding = await (await readinessRoute(get(`/api/campaigns/${campaignId}/funding-readiness`), ctx(campaignId))).json();
    expect(readyForFunding.fundingReadiness).toMatchObject({
      ready: false,
      reason: "ready_for_funding",
      settlementStatus: "configured",
      requiredAmountLuna: "580000",
    });

    // 3. Publish while the settlement root is still configured (the only
    // publishable moment); re-publish conflicts.
    const published = await publishRoute(jsonPost(`/api/campaigns/${campaignId}/publish`, {}), ctx(campaignId));
    expect(published.status).toBe(200);
    expect((await published.json()).campaign.status).toBe("published");
    const republish = await publishRoute(jsonPost(`/api/campaigns/${campaignId}/publish`, {}), ctx(campaignId));
    expect(republish.status).toBe(409);

    // 4-6. Intent carries server vault/amount/reference; the wallet hash is
    // simulated (no network) and bound back.
    const intentResponse = await intentRoute(jsonPost(`/api/campaigns/${campaignId}/funding/intents`, {}), ctx(campaignId));
    expect(intentResponse.status).toBe(201);
    const { fundingIntent } = await intentResponse.json();
    expect(fundingIntent.requiredFundingLuna).toBe("580000");
    expect(fundingIntent.vaultAddressHex).toMatch(/^[0-9a-f]{40}$/);
    expect(fundingIntent.reference.length).toBeGreaterThan(0);
    const txHash = hex(32);
    const bindResponse = await bindRoute(
      jsonPost(`/api/campaigns/${campaignId}/funding/intents/${fundingIntent.fundingIntentId}/bind`, { transactionHash: txHash }),
      ctx(campaignId, { intentId: fundingIntent.fundingIntentId }),
    );
    expect(bindResponse.status).toBe(201);

    // 7-8. Finality through the real confirm route with stubbed observation;
    // readiness flips to funded/ready.
    mocks.fundingObservation = async (hash) =>
      observedFunding(creator.address, hash, fundingIntent.vaultAddressHex, BigInt("580000"), fundingIntent.reference);
    const confirmResponse = await confirmRoute(
      jsonPost(`/api/campaigns/${campaignId}/funding/intents/${fundingIntent.fundingIntentId}/confirm`, {}),
      ctx(campaignId, { intentId: fundingIntent.fundingIntentId }),
    );
    expect(confirmResponse.status).toBe(200);
    mocks.fundingObservation = null;
    const funded = await (await readinessRoute(get(`/api/campaigns/${campaignId}/funding-readiness`), ctx(campaignId))).json();
    expect(funded.fundingReadiness).toMatchObject({ ready: true, settlementStatus: "funded" });

    // 9. Public DTO: safe aggregates, no claimant-private data.
    const pub = await publicRoute(get(`/api/campaigns/${campaignId}/public`), ctx(campaignId));
    expect(pub.status).toBe(200);
    const dto = await pub.json();
    expect(dto).toMatchObject({
      campaignId,
      remainingRewards: 10,
      reservedCount: 0,
      paidCount: 0,
    });
    expect(JSON.stringify(dto)).not.toMatch(/wallet|vault|challenge|receipt|secret|refund/i);

    // 10. Close stops new claims; replay stays closed.
    const closed = await closeRoute(jsonPost(`/api/campaigns/${campaignId}/close`, {}), ctx(campaignId));
    expect(closed.status).toBe(200);
    const closedAgain = await closeRoute(jsonPost(`/api/campaigns/${campaignId}/close`, {}), ctx(campaignId));
    expect(closedAgain.status).toBe(200);
    const participant = freshWallet();
    mocks.session = { address: participant.address, tokenHash: hex(32) };
    const lateChallenge = await challengeRoute(jsonPost(`/api/campaigns/${campaignId}/claims/challenge`, {}), ctx(campaignId));
    if (lateChallenge.status === 201) {
      const lateBody = await lateChallenge.json();
      const lateClaim = await claimRoute(
        jsonPost(`/api/campaigns/${campaignId}/claims`, {
          challengeId: lateBody.challengeId,
          address: participant.address,
          publicKey: participant.publicKey,
          signature: participant.sign(lateBody.message),
        }),
        ctx(campaignId),
      );
      expect(lateClaim.status).not.toBe(201);
    } else {
      expect(lateChallenge.status).not.toBe(201);
    }
    mocks.session = { address: creator.address, tokenHash: ownerToken };

    // 11. Refund through the real route with stubbed transport: one send.
    const refunded = await refundRoute(jsonPost(`/api/campaigns/${campaignId}/refund`, {}), ctx(campaignId));
    expect(refunded.status).toBe(200);
    const refundBody = await refunded.json();
    expect(refundBody.status).toBe("broadcasted");
    expect(mocks.refundSends).toBe(1);
    const refunds = await admin.from("reward_refunds").select("id, creator_wallet, amount_luna, status")
      .eq("settlement_id", settlementId);
    expect(refunds.data).toHaveLength(1);
    expect(refunds.data?.[0].creator_wallet).toBe(creator.address);
    expect(Number(refunds.data?.[0].amount_luna)).toBeGreaterThan(0);

    // Replay reuses the same intent: no second send, same refund row.
    const replay = await refundRoute(jsonPost(`/api/campaigns/${campaignId}/refund`, {}), ctx(campaignId));
    expect(replay.status).toBe(200);
    expect((await replay.json()).refundId).toBe(refundBody.refundId);
    expect(mocks.refundSends).toBe(1);
    expect((await admin.from("reward_refunds").select("id").eq("settlement_id", settlementId)).data).toHaveLength(1);

    // 12-13. Final confirmation → stable terminal state.
    const confirmed = await confirmRefundRpc(refundBody.refundId, settlementId, refundBody.transactionHash);
    expect(confirmed.result_kind).toBe("confirmed");
    const terminal = await refundRoute(jsonPost(`/api/campaigns/${campaignId}/refund`, {}), ctx(campaignId));
    expect(terminal.status).toBe(200);
    expect((await terminal.json()).status).toBe("refunded");
    const settled = await admin.from("reward_settlements").select("status").eq("id", settlementId).single();
    expect(settled.data?.status).toBe("refunded");
    mocks.session = null;
  });

  it("unresolved payout blocks refund; resolving it unblocks", async () => {
    const creator = freshWallet();
    const participant = freshWallet();
    const ownerToken = await ownerSessionToken(creator.address);
    mocks.session = { address: creator.address, tokenHash: ownerToken };

    const createResponse = await createRoute(
      jsonPost("/api/campaigns", {
        type: "public_giveaway",
        title: `C6 blocked-refund proof ${randomUUID()}`,
        description: null,
        visibility: "public",
        startsAt: null,
        endsAt: null,
        rewardPerParticipant: "0.5",
        maxRewardedParticipants: 10,
        fundingMode: "creator",
      }),
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const campaignId = created.campaign.campaignId as string;
    createdCampaignIds.push(campaignId);
    const { data: campaignRow } = await admin.from("participation_campaigns")
      .select("settlement_id").eq("id", campaignId).single();
    const settlementId = campaignRow?.settlement_id as string;
    createdRootIds.push(settlementId);
    await ensureRewardSettlementVault(settlementId);
    expect((await publishRoute(jsonPost(`/api/campaigns/${campaignId}/publish`, {}), ctx(campaignId))).status).toBe(200);

    const intentResponse = await intentRoute(jsonPost(`/api/campaigns/${campaignId}/funding/intents`, {}), ctx(campaignId));
    const { fundingIntent } = await intentResponse.json();
    const txHash = hex(32);
    await bindRoute(
      jsonPost(`/api/campaigns/${campaignId}/funding/intents/${fundingIntent.fundingIntentId}/bind`, { transactionHash: txHash }),
      ctx(campaignId, { intentId: fundingIntent.fundingIntentId }),
    );
    mocks.fundingObservation = async (hash) =>
      observedFunding(creator.address, hash, fundingIntent.vaultAddressHex, BigInt("580000"), fundingIntent.reference);
    const confirmResponse = await confirmRoute(
      jsonPost(`/api/campaigns/${campaignId}/funding/intents/${fundingIntent.fundingIntentId}/confirm`, {}),
      ctx(campaignId, { intentId: fundingIntent.fundingIntentId }),
    );
    expect(confirmResponse.status).toBe(200);
    mocks.fundingObservation = null;

    // ONE participant reserves; the handoff is counted, never executed.
    mocks.session = { address: participant.address, tokenHash: hex(32) };
    const challengeResponse = await challengeRoute(jsonPost(`/api/campaigns/${campaignId}/claims/challenge`, {}), ctx(campaignId));
    expect(challengeResponse.status).toBe(201);
    const challenge = await challengeResponse.json();
    const claimResponse = await claimRoute(
      jsonPost(`/api/campaigns/${campaignId}/claims`, {
        challengeId: challenge.challengeId,
        address: participant.address,
        publicKey: participant.publicKey,
        signature: participant.sign(challenge.message),
      }),
      ctx(campaignId),
    );
    expect(claimResponse.status).toBe(201);
    const receiptId = (await claimResponse.json()).receiptId as string;
    expect(mocks.payoutHandoffs).toBe(1);

    // Close preserves the earned reservation; refund is blocked with zero intents.
    mocks.session = { address: creator.address, tokenHash: ownerToken };
    expect((await closeRoute(jsonPost(`/api/campaigns/${campaignId}/close`, {}), ctx(campaignId))).status).toBe(200);
    const blocked = await refundRoute(jsonPost(`/api/campaigns/${campaignId}/refund`, {}), ctx(campaignId));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toBe("unresolved_reward_obligations");
    expect((await admin.from("reward_refunds").select("id").eq("settlement_id", settlementId)).data).toHaveLength(0);

    // Settle the obligation with the existing payout primitive, then refund.
    const payout = await runRewardPayout({ receiptId, campaignId: settlementId }, payoutDeps());
    expect(payout.kind).toBe("broadcasted");
    if (payout.kind !== "broadcasted") throw new Error("expected payout broadcast");
    const paid = await confirmPayoutRpc(receiptId, settlementId, payout.transactionHash);
    expect(paid.result_kind).toBe("confirmed");
    const unblocked = await refundRoute(jsonPost(`/api/campaigns/${campaignId}/refund`, {}), ctx(campaignId));
    expect(unblocked.status).toBe(200);
    expect((await unblocked.json()).status).toBe("broadcasted");
    const receipts = await admin.from("reward_receipts").select("status").eq("id", receiptId).single();
    expect(receipts.data?.status).toBe("paid");
    mocks.session = null;
  });
});
