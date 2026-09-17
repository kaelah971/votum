import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { KeyPair, Signature } from "@nimiq/core";
import { createParticipationCampaign } from "@/lib/campaigns/configuration";
import {
  issueCampaignClaimChallenge,
  verifyCampaignClaimSignature,
} from "@/lib/campaigns/claim-challenge";
import { deriveAddressFromPublicKey } from "@/lib/nimiq/server-crypto";
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
const createdChallengeIds: string[] = [];

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

async function createCampaign() {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: "Claim challenge library fixture",
    description: null,
    visibility: "unlisted",
    startsAt: null,
    endsAt: null,
    rewardPerParticipant: "0.5",
    maxRewardedParticipants: 10,
    fundingMode: "creator",
  });
  createdCampaignIds.push(result.campaign.campaignId);
  createdRootIds.push(result.campaign.settlementId);
  return result.campaign;
}

async function readChallenge(id: string) {
  const { data, error } = await admin.from("campaign_claim_challenges")
    .select("id, campaign_id, participant_wallet, nonce_hash, action, version, message, issued_at, expires_at, consumed_at")
    .eq("id", id)
    .single();
  if (error || !data) throw error ?? new Error("challenge fixture missing");
  return data;
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterAll(() => {
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
    DELETE FROM public.settlement_source_bindings WHERE settlement_id IN (${roots});
    DELETE FROM public.participation_campaigns WHERE id IN (${campaigns});
    DELETE FROM public.reward_settlements WHERE id IN (${roots});
    COMMIT;
  `);
  createdCampaignIds.length = 0;
  createdRootIds.length = 0;
});

describe("V2C.3C challenge issue and verification against live storage", () => {
  it("issues unique nonce hashes with a five-minute persisted expiry", async () => {
    const campaign = await createCampaign();
    const wallet = freshWallet();

    const first = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: wallet.address,
    });
    const second = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: wallet.address,
    });
    createdChallengeIds.push(first.challengeId, second.challengeId);

    const firstRow = await readChallenge(first.challengeId);
    const secondRow = await readChallenge(second.challengeId);
    expect(firstRow.nonce_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(secondRow.nonce_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(secondRow.nonce_hash).not.toBe(firstRow.nonce_hash);
    // Locked semantic: slice C never writes consumed_at. A re-issue leaves
    // the earlier challenge valid until its own expiry; only the slice-D
    // atomic claim transaction consumes the exact challenge it reserves with.
    expect(firstRow.consumed_at).toBeNull();
    expect(secondRow.consumed_at).toBeNull();
    expect(firstRow.action).toBe("campaign_claim");
    expect(firstRow.version).toBe(1);

    const ttlMs = Date.parse(firstRow.expires_at) - Date.parse(firstRow.issued_at);
    expect(ttlMs).toBe(5 * 60 * 1000);

    const firstNonce = first.message.split("\n").find((line) => line.startsWith("Nonce: "));
    expect(firstRow.nonce_hash).toBe(
      createHash("sha256").update((firstNonce as string).replace("Nonce: ", ""), "utf8").digest("hex"),
    );
  });

  it("verifies a real signature without consuming the challenge", async () => {
    const campaign = await createCampaign();
    const wallet = freshWallet();
    const issued = await issueCampaignClaimChallenge(admin as never, {
      campaignId: campaign.campaignId,
      sessionAddress: wallet.address,
    });
    createdChallengeIds.push(issued.challengeId);

    const result = await verifyCampaignClaimSignature(admin as never, {
      challengeId: issued.challengeId,
      campaignId: campaign.campaignId,
      address: wallet.address,
      publicKey: wallet.publicKey,
      signature: wallet.sign(issued.message),
    });
    expect(result).toEqual({ kind: "ok", participantWallet: wallet.address });

    // Slice C owns no consumption: the authoritative consumed_at mutation
    // belongs to the future atomic claim transaction in slice D.
    const row = await readChallenge(issued.challengeId);
    expect(row.consumed_at).toBeNull();
  });
});
