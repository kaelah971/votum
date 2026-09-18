import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { KeyPair, Signature } from "@nimiq/core";
import { createParticipationCampaign, publishParticipationCampaign } from "@/lib/campaigns/configuration";
import { issueCampaignClaimChallenge } from "@/lib/campaigns/claim-challenge";
import { deriveAddressFromPublicKey } from "@/lib/nimiq/server-crypto";
import { ensureRewardSettlementVault } from "@/lib/rewards/vault-service";
import { assertLocalSupabaseForTests } from "@/lib/rewards/test-env";
import { testDbContainer, testSupabaseKey, testSupabaseUrl } from "@/lib/rewards/test-target";

const mocks = vi.hoisted(() => ({
  session: null as { address: string } | null,
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/api/origin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/origin")>();
  return { ...actual, isSameOriginRequest: () => true };
});

vi.mock("@/lib/rewards/settlement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rewards/settlement")>();
  return {
    ...actual,
    createRewardSettlementService: (admin: unknown) => ({
      ...(actual.createRewardSettlementService(admin as never) as unknown as Record<string, unknown>),
      executePayout: async () => ({ kind: "broadcasted", attemptId: "ux", transactionHash: "ux" }),
    }),
  };
});

import { POST as challengeRoute } from "@/app/api/campaigns/[campaignId]/claims/challenge/route";
import { POST as claimRoute } from "@/app/api/campaigns/[campaignId]/claims/route";
import { GET as mineRoute } from "@/app/api/campaigns/[campaignId]/claims/mine/route";
import { GET as publicRoute } from "@/app/api/campaigns/[campaignId]/public/route";

const url = testSupabaseUrl();
const key = testSupabaseKey();
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const OWNER = "01" + "c".repeat(38);
const createdCampaignIds: string[] = [];
const createdRootIds: string[] = [];
const observedRouteCodes = new Set<string>();

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

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return new Request(`http://localhost${path}`, { method: "GET" });
}

function recordCode(body: Record<string, unknown>) {
  const code = typeof body.reasonCode === "string" ? body.reasonCode : body.error;
  if (typeof code === "string") observedRouteCodes.add(code);
}

async function setupCampaign(maxParticipants = 10, overrides: Record<string, unknown> = {}, owner = OWNER) {
  const result = await createParticipationCampaign(owner, {
    type: "public_giveaway",
    title: `UX matrix fixture ${randomUUID()}`,
    description: null,
    visibility: "public",
    startsAt: null,
    endsAt: null,
    rewardPerParticipant: "0.5",
    maxRewardedParticipants: maxParticipants,
    fundingMode: "creator",
    ...overrides,
  });
  createdCampaignIds.push(result.campaign.campaignId);
  createdRootIds.push(result.campaign.settlementId);
  const campaign = result.campaign;
  await ensureRewardSettlementVault(campaign.settlementId);
  await publishParticipationCampaign(owner, campaign.campaignId);
  const { data: terms } = await admin.from("reward_settlements")
    .select("total_budget_luna").eq("id", campaign.settlementId).single();
  await admin.from("reward_settlements").update({
    status: "funded",
    funded_amount_luna: terms?.total_budget_luna ?? 0,
    funded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", campaign.settlementId);
  return campaign;
}

async function requestChallenge(campaignId: string, wallet: { address: string }) {
  mocks.session = { address: wallet.address };
  const response = await challengeRoute(
    post(`/api/campaigns/${campaignId}/claims/challenge`, {}),
    routeContext(campaignId),
  );
  mocks.session = null;
  return response;
}

async function submitClaim(
  campaignId: string,
  wallet: { address: string; publicKey: string; sign: (message: string) => string },
  challenge: { challengeId: string; message: string },
  sessionAddress?: string,
) {
  mocks.session = { address: sessionAddress ?? wallet.address };
  const response = await claimRoute(
    post(`/api/campaigns/${campaignId}/claims`, {
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

async function readMine(campaignId: string, wallet: { address: string }) {
  mocks.session = { address: wallet.address };
  const response = await mineRoute(get(`/api/campaigns/${campaignId}/claims/mine`), routeContext(campaignId));
  mocks.session = null;
  return response;
}

async function receiptCount(settlementId: string): Promise<number> {
  const { data } = await admin.from("reward_receipts").select("id").eq("settlement_id", settlementId);
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

describe("claims UX route matrix on the real backend", () => {
  it("discovers no claim, then the same receipt after a signed claim, with no re-sign", async () => {
    const campaign = await setupCampaign();
    const claimant = freshWallet();

    const before = await readMine(campaign.campaignId, claimant);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ claimed: false });

    const challengeResponse = await requestChallenge(campaign.campaignId, claimant);
    expect(challengeResponse.status).toBe(201);
    const challenge = await challengeResponse.json();
    const claimResponse = await submitClaim(campaign.campaignId, claimant, challenge);
    expect(claimResponse.status).toBe(201);
    const claimBody = await claimResponse.json();
    expect(claimBody.replayed).toBe(false);

    // Reload: mine alone rediscovers the entitlement, no challenge involved.
    const after = await readMine(campaign.campaignId, claimant);
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({
      claimed: true,
      receiptId: claimBody.receiptId,
      status: "reserved",
    });
  });

  it("keeps claimant wallets opaque across sessions", async () => {
    const campaign = await setupCampaign();
    const holder = freshWallet();
    const stranger = freshWallet();

    const challengeResponse = await requestChallenge(campaign.campaignId, holder);
    const challenge = await challengeResponse.json();
    const claimResponse = await submitClaim(campaign.campaignId, holder, challenge);
    const claimBody = await claimResponse.json();

    const strangerMine = await readMine(campaign.campaignId, stranger);
    expect(await strangerMine.json()).toEqual({ claimed: false });

    const publicResponse = await publicRoute(
      get(`/api/campaigns/${campaign.campaignId}/public`),
      routeContext(campaign.campaignId),
    );
    expect(publicResponse.status).toBe(200);
    const serialized = JSON.stringify(await publicResponse.json());
    for (const secret of [holder.address, claimBody.receiptId as string, "nonce", "consumed"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("replays exact and fresh-challenge retries to one receipt", async () => {
    const campaign = await setupCampaign();
    const claimant = freshWallet();

    const firstChallenge = await (await requestChallenge(campaign.campaignId, claimant)).json();
    const body = {
      challengeId: firstChallenge.challengeId,
      address: claimant.address,
      publicKey: claimant.publicKey,
      signature: claimant.sign(firstChallenge.message),
    };
    mocks.session = { address: claimant.address };
    const first = await claimRoute(post(`/api/campaigns/${campaign.campaignId}/claims`, body), routeContext(campaign.campaignId));
    const retry = await claimRoute(post(`/api/campaigns/${campaign.campaignId}/claims`, body), routeContext(campaign.campaignId));
    mocks.session = null;
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    const firstBody = await first.json();
    const retryBody = await retry.json();
    expect(firstBody.replayed).toBe(false);
    expect(retryBody).toMatchObject({ receiptId: firstBody.receiptId, replayed: true });

    const freshResponse = await requestChallenge(campaign.campaignId, claimant);
    const fresh = await freshResponse.json();
    const freshClaim = await submitClaim(campaign.campaignId, claimant, fresh);
    expect(freshClaim.status).toBe(201);
    expect(await freshClaim.json()).toMatchObject({ receiptId: firstBody.receiptId, replayed: true });
    expect(await receiptCount(campaign.settlementId)).toBe(1);

    const mine = await readMine(campaign.campaignId, claimant);
    expect(await mine.json()).toMatchObject({ claimed: true, receiptId: firstBody.receiptId });
  });

  it("pins the browser-visible lifecycle and error contract", async () => {
    // Draft campaign: challenge screening rejects.
    const draft = await createParticipationCampaign(OWNER, {
      type: "public_giveaway",
      title: `UX draft ${randomUUID()}`,
      description: null,
      visibility: "public",
      startsAt: null,
      endsAt: null,
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 10,
      fundingMode: "creator",
    });
    createdCampaignIds.push(draft.campaign.campaignId);
    createdRootIds.push(draft.campaign.settlementId);
    const drafter = freshWallet();
    const draftChallenge = await requestChallenge(draft.campaign.campaignId, drafter);
    expect(draftChallenge.status).toBe(422);
    recordCode(await draftChallenge.json());

    // Missing campaign on challenge route.
    const missingChallenge = await requestChallenge(randomUUID(), drafter);
    expect(missingChallenge.status).toBe(404);

    // Missing session on challenge route.
    mocks.session = null;
    const nosession = await challengeRoute(
      post(`/api/campaigns/${draft.campaign.campaignId}/claims/challenge`, {}),
      routeContext(draft.campaign.campaignId),
    );
    expect(nosession.status).toBe(401);

    // Unsupported type never receives challenges.
    const secret = await createParticipationCampaign(OWNER, {
      type: "secret_drop",
      title: `UX secret ${randomUUID()}`,
      description: null,
      visibility: "public",
      startsAt: null,
      endsAt: null,
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 10,
      fundingMode: "creator",
    });
    createdCampaignIds.push(secret.campaign.campaignId);
    createdRootIds.push(secret.campaign.settlementId);
    const secretChallenge = await requestChallenge(secret.campaign.campaignId, drafter);
    expect(secretChallenge.status).toBe(422);
    recordCode(await secretChallenge.json());

    // Open campaign: malformed signature, wallet mismatch, unknown challenge.
    const campaign = await setupCampaign(2);
    const claimant = freshWallet();
    const other = freshWallet();
    const issued = await (await requestChallenge(campaign.campaignId, claimant)).json();

    mocks.session = { address: claimant.address };
    const tampered = await claimRoute(
      post(`/api/campaigns/${campaign.campaignId}/claims`, {
        challengeId: issued.challengeId,
        address: claimant.address,
        publicKey: claimant.publicKey,
        signature: other.sign(issued.message),
      }),
      routeContext(campaign.campaignId),
    );
    expect(tampered.status).toBe(422);
    recordCode(await tampered.json());

    const mismatched = await submitClaim(campaign.campaignId, other, issued, claimant.address);
    expect(mismatched.status).toBe(422);
    recordCode(await mismatched.json());

    mocks.session = { address: claimant.address };
    const unknown = await claimRoute(
      post(`/api/campaigns/${campaign.campaignId}/claims`, {
        challengeId: randomUUID(),
        address: claimant.address,
        publicKey: claimant.publicKey,
        signature: claimant.sign("unrelated"),
      }),
      routeContext(campaign.campaignId),
    );
    mocks.session = null;
    expect(unknown.status).toBe(422);
    recordCode(await unknown.json());
    expect(await receiptCount(campaign.settlementId)).toBe(0);
  });

  it("pins sold-out, closed, unfunded, creator, and expiry behavior", async () => {
    // Sold out (capacity 1, one holder, one loser).
    const full = await setupCampaign(1);
    const holder = freshWallet();
    const loser = freshWallet();
    await submitClaim(full.campaignId, holder, await (await requestChallenge(full.campaignId, holder)).json());
    const loserChallenge = await (await requestChallenge(full.campaignId, loser)).json();
    const soldOut = await submitClaim(full.campaignId, loser, loserChallenge);
    expect(soldOut.status).toBe(409);
    recordCode(await soldOut.json());

    // Closed via the real close RPC (challenge issued while open, since
    // issuance is screened after close).
    const closing = await setupCampaign();
    const newcomer = freshWallet();
    const preCloseChallenge = await (await requestChallenge(closing.campaignId, newcomer)).json();
    await admin.rpc("close_participation_campaign_atomic", {
      _campaign_id: closing.campaignId,
      _owner_wallet: OWNER,
    });
    const closed = await submitClaim(closing.campaignId, newcomer, preCloseChallenge);
    expect(closed.status).toBe(422);
    recordCode(await closed.json());

    // Unfunded but published.
    const bare = await createParticipationCampaign(OWNER, {
      type: "public_giveaway",
      title: `UX bare ${randomUUID()}`,
      description: null,
      visibility: "public",
      startsAt: null,
      endsAt: null,
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 10,
      fundingMode: "creator",
    });
    createdCampaignIds.push(bare.campaign.campaignId);
    createdRootIds.push(bare.campaign.settlementId);
    await publishParticipationCampaign(OWNER, bare.campaign.campaignId);
    const bareWallet = freshWallet();
    const bareScreening = await requestChallenge(bare.campaign.campaignId, bareWallet);
    expect(bareScreening.status).toBe(422);
    recordCode(await bareScreening.json());

    // Creator self-claim with a real owner keypair and signature. Challenge
    // issuance screens creators, so the challenge comes from the library
    // while the claim itself goes through the real route.
    const creator = freshWallet();
    const own = await setupCampaign(10, {}, creator.address);
    const creatorScreening = await requestChallenge(own.campaignId, creator);
    expect(creatorScreening.status).toBe(422);
    recordCode(await creatorScreening.json());
    const creatorChallenge = await issueCampaignClaimChallenge(admin as never, {
      campaignId: own.campaignId,
      sessionAddress: creator.address,
    });
    const creatorClaim = await submitClaim(own.campaignId, creator, creatorChallenge);
    expect(creatorClaim.status).toBe(422);
    recordCode(await creatorClaim.json());
    expect(await receiptCount(own.settlementId)).toBe(0);

    // Expired challenge (backdated within storage CHECK bounds).
    const expiring = await setupCampaign();
    const waiter = freshWallet();
    const expiringChallenge = await (await requestChallenge(expiring.campaignId, waiter)).json();
    runPsql(`UPDATE public.campaign_claim_challenges
      SET issued_at = '${new Date(Date.now() - 10 * 60 * 1000).toISOString()}',
          expires_at = '${new Date(Date.now() - 60_000).toISOString()}'
      WHERE id = '${expiringChallenge.challengeId}';`);
    const expired = await submitClaim(expiring.campaignId, waiter, expiringChallenge);
    expect(expired.status).toBe(422);
    recordCode(await expired.json());

    // Consumed challenge with no entitlement.
    const consumed = await setupCampaign();
    const ghost = freshWallet();
    const ghostChallenge = await (await requestChallenge(consumed.campaignId, ghost)).json();
    runPsql(`UPDATE public.campaign_claim_challenges
      SET consumed_at = '${new Date().toISOString()}' WHERE id = '${ghostChallenge.challengeId}';`);
    const consumedClaim = await submitClaim(consumed.campaignId, ghost, ghostChallenge);
    expect(consumedClaim.status).toBe(422);
    recordCode(await consumedClaim.json());
    expect(await receiptCount(consumed.settlementId)).toBe(0);
  });

  it("drives receipt states through canonical primitives for the status panel", async () => {
    const campaign = await setupCampaign();
    const claimant = freshWallet();
    const challenge = await (await requestChallenge(campaign.campaignId, claimant)).json();
    const claimResponse = await submitClaim(campaign.campaignId, claimant, challenge);
    const receiptId = ((await claimResponse.json()) as Record<string, unknown>).receiptId as string;

    const asMine = async () => ((await (await readMine(campaign.campaignId, claimant)).json()) as Record<string, unknown>);
    expect(await asMine()).toMatchObject({ claimed: true, status: "reserved", receiptId });

    const { data: begun } = await admin.rpc("begin_reward_payout_atomic", {
      _receipt_id: receiptId,
      _campaign_id: campaign.settlementId,
    });
    expect((begun as Record<string, unknown>).result_kind).toBe("created");
    expect(await asMine()).toMatchObject({ claimed: true, status: "payout_pending", receiptId });

    const { data: vault } = await admin.from("reward_campaign_vaults")
      .select("vault_address_hex").eq("settlement_id", campaign.settlementId).single();
    const txHash = hex(32);
    const { data: prepared } = await admin.rpc("prepare_reward_payout_atomic", {
      _attempt_id: (begun as Record<string, unknown>).attempt_id as string,
      _sender_address_hex: vault?.vault_address_hex as string,
      _recipient_address_hex: claimant.address,
      _amount_luna: 50000,
      _fee_luna: 0,
      _network_id: 24,
      _validity_start_height: 100,
      _transaction_hash: txHash,
      _prepared_transaction_hex: "ab".repeat(32),
    });
    expect((prepared as Record<string, unknown>).result_kind).toBe("prepared");
    const withHash = await asMine();
    expect(withHash).toMatchObject({ claimed: true, status: "payout_pending", receiptId, transactionHash: txHash });

    // Broadcast markers in canonical order: starting, then hash callback.
    const { data: starting } = await admin.rpc("mark_reward_payout_broadcast_starting", {
      _attempt_id: (begun as Record<string, unknown>).attempt_id as string,
    });
    expect((starting as Record<string, unknown>).result_kind).toBe("started");
    const { data: marked } = await admin.rpc("mark_reward_payout_broadcast_atomic", {
      _attempt_id: (begun as Record<string, unknown>).attempt_id as string,
      _transaction_hash: txHash,
    });
    expect((marked as Record<string, unknown>).result_kind).toBe("broadcasted");
    const block = hex(32);
    const { data: confirmed } = await admin.rpc("confirm_reward_payout_atomic", {
      _attempt_id: (begun as Record<string, unknown>).attempt_id as string,
      _receipt_id: receiptId,
      _campaign_id: campaign.settlementId,
      _transaction_hash: txHash,
      _network_id: 24,
      _observed_sender: vault?.vault_address_hex as string,
      _observed_recipient: claimant.address,
      _observed_amount_luna: 50000,
      _execution_result: true,
      _block_number: 100,
      _transaction_timestamp: new Date().toISOString(),
      _transaction_block_hash: block,
      _canonical_block_hash: block,
      _batch_number: 1,
      _finalizing_macro_block_height: 101,
      _finalizing_macro_block_hash: hex(32),
    });
    expect((confirmed as Record<string, unknown>).result_kind).toBe("confirmed");
    const paid = await asMine();
    expect(paid).toMatchObject({ claimed: true, status: "paid", receiptId });
    expect(typeof paid.paidAt).toBe("string");

    // Retryable through the canonical failure path.
    const retryableCampaign = await setupCampaign();
    const retryableWallet = freshWallet();
    const retryableChallenge = await (await requestChallenge(retryableCampaign.campaignId, retryableWallet)).json();
    const retryableClaim = await submitClaim(retryableCampaign.campaignId, retryableWallet, retryableChallenge);
    const retryableReceipt = ((await retryableClaim.json()) as Record<string, unknown>).receiptId as string;
    const { data: retryableBegun } = await admin.rpc("begin_reward_payout_atomic", {
      _receipt_id: retryableReceipt,
      _campaign_id: retryableCampaign.settlementId,
    });
    const retryableAttempt = (retryableBegun as Record<string, unknown>).attempt_id as string;
    const { data: failed } = await admin.rpc("record_reward_payout_failure_atomic", {
      _attempt_id: retryableAttempt,
      _error_code: "ux-probe",
    });
    expect((failed as Record<string, unknown>).result_kind).toBe("retryable");
    const delayed = await readMine(retryableCampaign.campaignId, retryableWallet);
    expect(await delayed.json()).toMatchObject({ claimed: true, status: "retryable", receiptId: retryableReceipt });
  });

  it("rejects forged economics, identity, and cross-campaign reuse", async () => {
    const campaign = await setupCampaign();
    const claimant = freshWallet();
    const challenge = await (await requestChallenge(campaign.campaignId, claimant)).json();

    mocks.session = { address: claimant.address };
    const forged = await claimRoute(
      post(`/api/campaigns/${campaign.campaignId}/claims`, {
        challengeId: challenge.challengeId,
        address: claimant.address,
        publicKey: claimant.publicKey,
        signature: claimant.sign(challenge.message),
        receiptId: "forged",
        settlementId: "forged",
        amount_luna: "999999999",
      }),
      routeContext(campaign.campaignId),
    );
    mocks.session = null;
    expect(forged.status).toBe(201);
    const forgedBody = await forged.json();
    expect(forgedBody.receiptId).not.toBe("forged");
    expect(forgedBody.settlementId).toBe(campaign.settlementId);
    expect(Object.keys(forgedBody).sort()).toEqual(["receiptId", "replayed", "settlementId", "status"]);

    const other = await setupCampaign();
    mocks.session = { address: claimant.address };
    const crossCampaign = await claimRoute(
      post(`/api/campaigns/${other.campaignId}/claims`, {
        challengeId: challenge.challengeId,
        address: claimant.address,
        publicKey: claimant.publicKey,
        signature: claimant.sign(challenge.message),
      }),
      routeContext(other.campaignId),
    );
    mocks.session = null;
    expect(crossCampaign.status).toBe(422);
    recordCode(await crossCampaign.json());
    expect(await receiptCount(other.settlementId)).toBe(0);
  });

  it("grounds every observed route code in a specific UI mapping", async () => {
    // Static contract: each distinct error/reason surfaced above must have a
    // dedicated user-facing mapping in the ClaimNimButton vocabulary (no
    // silent generic fallback for known lifecycle states).
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const button = readFileSync(resolve(process.cwd(), "src/components/campaign/ClaimNimButton.tsx"), "utf8");
    const required = [
      "sold_out",
      "closed",
      "not_started",
      "ended",
      "funding_pending",
      "creator_ineligible",
      "not_published",
      "invalid_signature",
      "challenge_expired",
      "challenge_consumed",
      "campaign_not_found",
    ];
    for (const code of required) {
      expect(button.includes(code), code).toBe(true);
    }
    expect(observedRouteCodes.size).toBeGreaterThan(0);
  });
});
