import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  executePayout: vi.fn(),
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/api/origin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/origin")>();
  return {
    ...actual,
    isSameOriginRequest: () => true,
  };
});

vi.mock("@/lib/rewards/settlement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rewards/settlement")>();
  return {
    ...actual,
    createRewardSettlementService: () => ({ executePayout: mocks.executePayout }),
  };
});

import { POST as claimRoute } from "@/app/api/campaigns/[campaignId]/claims/route";

const url = testSupabaseUrl();
const key = testSupabaseKey();
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const OWNER = "01" + "c".repeat(38);
const createdCampaignIds: string[] = [];
const createdRootIds: string[] = [];

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

async function openCampaign() {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: `Claim replay fixture ${randomUUID()}`,
    description: null,
    visibility: "public",
    startsAt: null,
    endsAt: null,
    rewardPerParticipant: "0.5",
    maxRewardedParticipants: 10,
    fundingMode: "creator",
  });
  createdCampaignIds.push(result.campaign.campaignId);
  createdRootIds.push(result.campaign.settlementId);
  await ensureRewardSettlementVault(result.campaign.settlementId);
  await publishParticipationCampaign(OWNER, result.campaign.campaignId);
  const { error } = await admin.from("reward_settlements").update({
    status: "funded",
    funded_amount_luna: 500000,
    funded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", result.campaign.settlementId);
  if (error) throw error;
  return result.campaign;
}

function claimRequest(campaignId: string, body: unknown): Request {
  return new Request(`http://localhost/api/campaigns/${campaignId}/claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routeContext(campaignId: string) {
  return { params: Promise.resolve({ campaignId }) };
}

async function receiptCount(settlementId: string): Promise<number> {
  const { data } = await admin.from("reward_receipts").select("id").eq("settlement_id", settlementId);
  return data?.length ?? -1;
}

async function consumedAt(challengeId: string): Promise<string | null> {
  const { data } = await admin.from("campaign_claim_challenges")
    .select("consumed_at")
    .eq("id", challengeId)
    .single();
  return (data?.consumed_at as string | null) ?? null;
}

beforeAll(() => {
  assertLocalSupabaseForTests();
  mocks.executePayout.mockResolvedValue({ kind: "broadcasted" });
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

describe("POST /api/campaigns/[campaignId]/claims replay boundary", () => {
  it("replays an exact same-request retry with real crypto, adapter, service, and M3", async () => {
    const campaign = await openCampaign();
    const claimant = freshWallet();
    mocks.session = { address: claimant.address };

    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: claimant.address,
    });
    const body = {
      challengeId: issued.challengeId,
      address: claimant.address,
      publicKey: claimant.publicKey,
      signature: claimant.sign(issued.message),
    };

    const first = await claimRoute(claimRequest(campaign.campaignId, body), routeContext(campaign.campaignId));
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ settlementId: campaign.settlementId, replayed: false });
    expect(firstBody.receiptId).toBeTruthy();
    expect(await consumedAt(issued.challengeId)).not.toBeNull();

    // Exact same signed request again: the consumed challenge must reach M3
    // and replay the same receipt instead of failing closed at the verifier.
    const second = await claimRoute(claimRequest(campaign.campaignId, body), routeContext(campaign.campaignId));
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({
      receiptId: firstBody.receiptId,
      settlementId: campaign.settlementId,
      status: "reserved",
      replayed: true,
    });
    expect(await receiptCount(campaign.settlementId)).toBe(1);

    // Fresh challenge on the existing reservation replays and is consumed.
    const fresh = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: claimant.address,
    });
    const freshBody = {
      challengeId: fresh.challengeId,
      address: claimant.address,
      publicKey: claimant.publicKey,
      signature: claimant.sign(fresh.message),
    };
    const third = await claimRoute(claimRequest(campaign.campaignId, freshBody), routeContext(campaign.campaignId));
    expect(third.status).toBe(201);
    expect(await third.json()).toMatchObject({ receiptId: firstBody.receiptId, replayed: true });
    expect(await consumedAt(fresh.challengeId)).not.toBeNull();
    expect(await receiptCount(campaign.settlementId)).toBe(1);
    mocks.session = null;
  });

  it("rejects a consumed challenge with no reservation and mutates nothing", async () => {
    const campaign = await openCampaign();
    const claimant = freshWallet();
    mocks.session = { address: claimant.address };

    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: claimant.address,
    });
    runPsql(`UPDATE public.campaign_claim_challenges
      SET consumed_at = '${new Date().toISOString()}' WHERE id = '${issued.challengeId}';`);
    const before = await receiptCount(campaign.settlementId);

    const response = await claimRoute(claimRequest(campaign.campaignId, {
      challengeId: issued.challengeId,
      address: claimant.address,
      publicKey: claimant.publicKey,
      signature: claimant.sign(issued.message),
    }), routeContext(campaign.campaignId));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("challenge_consumed");
    expect(await receiptCount(campaign.settlementId)).toBe(before);
    mocks.session = null;
  });

  it("rejects a forged signature before any reservation mutation", async () => {
    const campaign = await openCampaign();
    const claimant = freshWallet();
    const other = freshWallet();
    mocks.session = { address: claimant.address };

    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: claimant.address,
    });
    const before = await receiptCount(campaign.settlementId);
    const response = await claimRoute(claimRequest(campaign.campaignId, {
      challengeId: issued.challengeId,
      address: claimant.address,
      publicKey: claimant.publicKey,
      signature: other.sign(issued.message),
    }), routeContext(campaign.campaignId));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("invalid_signature");
    expect(await receiptCount(campaign.settlementId)).toBe(before);
    expect(await consumedAt(issued.challengeId)).toBeNull();
    mocks.session = null;
  });
});
