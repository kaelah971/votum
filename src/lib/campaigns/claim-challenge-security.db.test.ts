import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { KeyPair, Signature } from "@nimiq/core";
import { createParticipationCampaign, publishParticipationCampaign } from "@/lib/campaigns/configuration";
import {
  issueCampaignClaimChallenge,
  verifyCampaignClaimSignature,
} from "@/lib/campaigns/claim-challenge";
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

import { POST as challengeRoute } from "@/app/api/campaigns/[campaignId]/claims/challenge/route";

const url = testSupabaseUrl();
const key = testSupabaseKey();
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

const OWNER = "01" + "c".repeat(38);
const createdCampaignIds: string[] = [];
const createdRootIds: string[] = [];
const createdChallengeIds: string[] = [];
let probeUserId: string | null = null;

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

async function createCampaign(overrides: Record<string, unknown> = {}) {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: `Security matrix fixture ${randomUUID()}`,
    description: null,
    visibility: "public",
    startsAt: null,
    endsAt: null,
    rewardPerParticipant: "0.5",
    maxRewardedParticipants: 10,
    fundingMode: "creator",
    ...overrides,
  });
  createdCampaignIds.push(result.campaign.campaignId);
  createdRootIds.push(result.campaign.settlementId);
  return result.campaign;
}

async function openCampaign(title: string) {
  const campaign = await createCampaign({ title });
  await ensureRewardSettlementVault(campaign.settlementId);
  await publishParticipationCampaign(OWNER, campaign.campaignId);
  const { error } = await admin.from("reward_settlements").update({
    status: "funded",
    funded_amount_luna: 580000,
    funded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", campaign.settlementId);
  if (error) throw error;
  return campaign;
}

function challengeRequest(campaignId: string, body: unknown = {}): Request {
  return new Request(`http://localhost/api/campaigns/${campaignId}/claims/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routeContext(campaignId: string) {
  return { params: Promise.resolve({ campaignId }) };
}

async function readChallenge(id: string) {
  const { data, error } = await admin.from("campaign_claim_challenges").select("*").eq("id", id).single();
  if (error || !data) throw error ?? new Error("challenge fixture missing");
  return data;
}

function replaceLine(message: string, prefix: string, replacement: string): string {
  return message.split("\n").map((line) => (line.startsWith(prefix) ? replacement : line)).join("\n");
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterAll(async () => {
  if (probeUserId) {
    await admin.auth.admin.deleteUser(probeUserId);
    probeUserId = null;
  }
  if (createdChallengeIds.length > 0) {
    const ids = createdChallengeIds.map((id) => `'${id}'`).join(", ");
    runPsql(`DELETE FROM public.campaign_claim_challenges WHERE id IN (${ids});`);
    createdChallengeIds.length = 0;
  }
  if (createdCampaignIds.length === 0) return;
  const campaigns = createdCampaignIds.map((id) => `'${id}'`).join(", ");
  const roots = createdRootIds.map((id) => `'${id}'`).join(", ");
  runPsql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.campaign_claim_challenges WHERE campaign_id IN (${campaigns});
    DELETE FROM public.reward_campaign_vaults WHERE settlement_id IN (${roots});
    DELETE FROM public.settlement_source_bindings WHERE settlement_id IN (${roots});
    DELETE FROM public.participation_campaigns WHERE id IN (${campaigns});
    DELETE FROM public.reward_settlements WHERE id IN (${roots});
    COMMIT;
  `);
  createdCampaignIds.length = 0;
  createdRootIds.length = 0;
});

describe("V2C.3C claim authorization security matrix", () => {
  it("issues a challenge for a valid session and campaign, and refuses anonymous callers", async () => {
    const campaign = await openCampaign("Matrix open campaign");
    const wallet = freshWallet();

    mocks.session = null;
    const denied = await challengeRoute(challengeRequest(campaign.campaignId), routeContext(campaign.campaignId));
    expect(denied.status).toBe(401);

    mocks.session = { address: wallet.address };
    const issued = await challengeRoute(challengeRequest(campaign.campaignId), routeContext(campaign.campaignId));
    expect(issued.status).toBe(201);
    const body = await issued.json();
    expect(Object.keys(body).sort()).toEqual(["challengeId", "expiresAt", "message"]);
    expect(body.message).toContain(campaign.campaignId);
    expect(body.message).toContain(wallet.address);
    const serialized = JSON.stringify(body);
    for (const forbidden of ["nonce_hash", "consumed", "settlement", "vault", "receipt", "token", "session"]) {
      expect(serialized).not.toContain(forbidden);
    }
    createdChallengeIds.push(body.challengeId);
  });

  it("ignores spoofed wallets: issuance and verification bind the session wallet", async () => {
    const campaign = await openCampaign("Matrix spoof campaign");
    const wallet = freshWallet();
    const attacker = freshWallet();

    mocks.session = { address: wallet.address };
    const issued = await challengeRoute(
      challengeRequest(campaign.campaignId, { address: attacker.address, wallet: attacker.address }),
      routeContext(campaign.campaignId),
    );
    expect(issued.status).toBe(201);
    const body = await issued.json();
    createdChallengeIds.push(body.challengeId);
    expect(body.message).toContain(wallet.address);
    expect(body.message).not.toContain(attacker.address);

    const spoofed = await verifyCampaignClaimSignature(admin as never, {
      challengeId: body.challengeId,
      campaignId: campaign.campaignId,
      address: attacker.address,
      publicKey: attacker.publicKey,
      signature: attacker.sign(body.message),
    });
    expect(spoofed).toMatchObject({ kind: "error", reasonCode: "wallet_mismatch" });
  });

  it("rejects creator self-claim authorization without storing a challenge", async () => {
    const campaign = await openCampaign("Matrix creator campaign");
    mocks.session = { address: OWNER };
    const response = await challengeRoute(challengeRequest(campaign.campaignId), routeContext(campaign.campaignId));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "claim_not_available",
      reasonCode: "creator_ineligible",
    });

    const { count } = await admin.from("campaign_claim_challenges")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaign.campaignId)
      .eq("participant_wallet", OWNER.toLowerCase());
    expect(count ?? 0).toBe(0);
  });

  it("rejects cross-campaign and cross-wallet signature reuse", async () => {
    const first = await openCampaign("Matrix campaign A");
    const second = await openCampaign("Matrix campaign B");
    const wallet = freshWallet();
    const other = freshWallet();

    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: first.campaignId,
      sessionAddress: wallet.address,
    });
    createdChallengeIds.push(issued.challengeId);
    const signature = wallet.sign(issued.message);

    await expect(verifyCampaignClaimSignature(admin as never, {
      challengeId: issued.challengeId,
      campaignId: second.campaignId,
      address: wallet.address,
      publicKey: wallet.publicKey,
      signature,
    })).resolves.toMatchObject({ kind: "error", reasonCode: "campaign_mismatch" });

    await expect(verifyCampaignClaimSignature(admin as never, {
      challengeId: issued.challengeId,
      campaignId: first.campaignId,
      address: other.address,
      publicKey: other.publicKey,
      signature,
    })).resolves.toMatchObject({ kind: "error", reasonCode: "wallet_mismatch" });
  });

  it("fails closed on tampered messages, nonces, actions, versions, and domains", async () => {
    const campaign = await openCampaign("Matrix tamper campaign");
    const wallet = freshWallet();
    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: wallet.address,
    });
    createdChallengeIds.push(issued.challengeId);
    const adminClient = admin as never;
    const base = {
      challengeId: issued.challengeId,
      campaignId: campaign.campaignId,
      address: wallet.address,
      publicKey: wallet.publicKey,
    };

    for (const [label, message] of [
      ["domain", replaceLine(issued.message, "Domain: ", "Domain: evil.example")],
      ["nonce", replaceLine(issued.message, "Nonce: ", "Nonce: forged-nonce")],
      ["action", replaceLine(issued.message, "Action: ", "Action: other_action")],
      ["version", replaceLine(issued.message, "Version: ", "Version: 2")],
    ] as const) {
      const tamperedSignature = wallet.sign(message);
      const intact = await verifyCampaignClaimSignature(adminClient, { ...base, signature: wallet.sign(issued.message) });
      expect(intact.kind, label).toBe("ok");
      const rejected = await verifyCampaignClaimSignature(adminClient, { ...base, signature: tamperedSignature });
      expect(rejected, label).toMatchObject({ kind: "error", reasonCode: "invalid_signature" });
    }

    const crossSigned = await verifyCampaignClaimSignature(adminClient, {
      ...base,
      signature: wallet.sign(replaceLine(issued.message, "Nonce: ", "Nonce: forged-nonce")),
    });
    expect(crossSigned).toMatchObject({ kind: "error", reasonCode: "invalid_signature" });
  });

  it("rejects expired, unknown, consumed, and malformed challenges", async () => {
    const campaign = await openCampaign("Matrix lifecycle campaign");
    const wallet = freshWallet();
    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: wallet.address,
    });
    createdChallengeIds.push(issued.challengeId);
    const adminClient = admin as never;
    const base = {
      campaignId: campaign.campaignId,
      address: wallet.address,
      publicKey: wallet.publicKey,
    };

    await expect(verifyCampaignClaimSignature(adminClient, {
      ...base,
      challengeId: randomUUID(),
      signature: wallet.sign(issued.message),
    })).resolves.toMatchObject({ kind: "error", reasonCode: "challenge_not_found" });

    await expect(verifyCampaignClaimSignature(adminClient, {
      ...base,
      challengeId: issued.challengeId,
      signature: "zzzz",
    })).resolves.toMatchObject({ kind: "error", reasonCode: "invalid_signature" });

    await expect(verifyCampaignClaimSignature(adminClient, {
      ...base,
      challengeId: issued.challengeId,
      address: "not-a-wallet",
      signature: wallet.sign(issued.message),
    })).resolves.toMatchObject({ kind: "error", reasonCode: "wallet_mismatch" });

    const pastIssued = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    runPsql(`UPDATE public.campaign_claim_challenges SET issued_at = '${pastIssued}', expires_at = '${past}' WHERE id = '${issued.challengeId}';`);
    await expect(verifyCampaignClaimSignature(adminClient, {
      ...base,
      challengeId: issued.challengeId,
      signature: wallet.sign(issued.message),
    })).resolves.toMatchObject({ kind: "error", reasonCode: "challenge_expired" });

    const now = new Date().toISOString();
    runPsql(`UPDATE public.campaign_claim_challenges SET expires_at = '${new Date(Date.now() + 300000).toISOString()}', consumed_at = '${now}' WHERE id = '${issued.challengeId}';`);
    await expect(verifyCampaignClaimSignature(adminClient, {
      ...base,
      challengeId: issued.challengeId,
      signature: wallet.sign(issued.message),
    })).resolves.toMatchObject({ kind: "error", reasonCode: "challenge_consumed" });
  });

  it("never issues challenges for unsupported Campaign types", async () => {
    const wallet = freshWallet();
    mocks.session = { address: wallet.address };
    for (const type of ["secret_drop", "private_drop", "event_drop", "community_reward"]) {
      const campaign = await createCampaign({
        type,
        title: `Matrix ${type} campaign`,
        visibility: "public",
      });
      const response = await challengeRoute(challengeRequest(campaign.campaignId), routeContext(campaign.campaignId));
      expect(response.status, type).toBe(422);
      expect(await response.json()).toMatchObject({
        error: "claim_not_available",
        reasonCode: "unsupported_type",
      });
    }
    mocks.session = null;
  });

  it("keeps challenge storage invisible to anon and authenticated roles", async () => {
    const campaign = await openCampaign("Matrix privacy campaign");
    const wallet = freshWallet();
    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: wallet.address,
    });
    createdChallengeIds.push(issued.challengeId);

    const publishable =
      process.env.VOTUM_CLEANROOM_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      "invalid";
    const anon = createClient(url, publishable, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { schema: "public" },
    });
    const anonRead = await anon.from("campaign_claim_challenges").select("id").limit(1);
    expect(anonRead.data ?? []).toEqual([]);
    const anonWrite = await anon.from("campaign_claim_challenges").insert({
      campaign_id: campaign.campaignId,
      participant_wallet: wallet.address,
      nonce_hash: randomBytes(32).toString("hex"),
      message: "probe",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300000).toISOString(),
    });
    expect(anonWrite.data).toBeNull();
    const anonDelete = await anon.from("campaign_claim_challenges").delete().eq("id", issued.challengeId);
    expect(anonDelete.data ?? []).toEqual([]);
    const stillThere = await readChallenge(issued.challengeId);
    expect(stillThere.id).toBe(issued.challengeId);

    const probeEmail = `matrix-probe-${randomUUID()}@example.invalid`;
    const probePassword = `probe-${randomBytes(12).toString("hex")}`;
    const created = await admin.auth.admin.createUser({
      email: probeEmail,
      password: probePassword,
      email_confirm: true,
    });
    if (!created.data?.user) throw new Error("probe user fixture missing");
    probeUserId = created.data.user.id;
    const signed = await createClient(url, publishable, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { schema: "public" },
    }).auth.signInWithPassword({ email: probeEmail, password: probePassword });
    const accessToken = signed.data.session?.access_token;
    expect(accessToken).toBeTruthy();

    const authed = createClient(url, publishable, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { schema: "public" },
      global: { headers: { Authorization: `Bearer ${accessToken as string}` } },
    });
    const authedRead = await authed.from("campaign_claim_challenges").select("id").limit(1);
    expect(authedRead.data ?? []).toEqual([]);
    const authedWrite = await authed.from("campaign_claim_challenges").insert({
      campaign_id: campaign.campaignId,
      participant_wallet: wallet.address,
      nonce_hash: randomBytes(32).toString("hex"),
      message: "probe",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300000).toISOString(),
    });
    expect(authedWrite.data).toBeNull();
    const authedUpdate = await authed.from("campaign_claim_challenges")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", issued.challengeId);
    expect(authedUpdate.data ?? []).toEqual([]);
  });

  it("keeps nonces unique and the public DTO free of challenge fields", async () => {
    const campaign = await openCampaign("Matrix uniqueness campaign");
    const wallet = freshWallet();
    mocks.session = { address: wallet.address };

    const first = await challengeRoute(challengeRequest(campaign.campaignId), routeContext(campaign.campaignId));
    const second = await challengeRoute(challengeRequest(campaign.campaignId), routeContext(campaign.campaignId));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = await first.json();
    const secondBody = await second.json();
    createdChallengeIds.push(firstBody.challengeId, secondBody.challengeId);
    expect(secondBody.challengeId).not.toBe(firstBody.challengeId);

    const { data: rows } = await admin.from("campaign_claim_challenges")
      .select("nonce_hash, consumed_at")
      .in("id", [firstBody.challengeId, secondBody.challengeId]);
    expect(rows?.map((row) => row.nonce_hash)).toHaveLength(2);
    expect(new Set((rows ?? []).map((row) => row.nonce_hash)).size).toBe(2);
    // Re-issue invalidates nothing: both challenges stay unconsumed in C.
    expect((rows ?? []).map((row) => row.consumed_at)).toEqual([null, null]);

    const { getPublicCampaignGiveaway } = await import("@/lib/campaigns/public-giveaway");
    const dto = await getPublicCampaignGiveaway(admin as never, campaign.campaignId);
    const serialized = JSON.stringify(dto);
    for (const forbidden of ["challenge", "nonce", "consumed"]) {
      expect(serialized).not.toContain(forbidden);
    }
    mocks.session = null;
  });
});
