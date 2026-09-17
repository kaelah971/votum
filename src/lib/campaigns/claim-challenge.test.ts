import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { KeyPair, Signature } from "@nimiq/core";
import {
  buildCampaignClaimMessage,
  CAMPAIGN_CLAIM_ACTION,
  CAMPAIGN_CLAIM_VERSION,
  issueCampaignClaimChallenge,
  verifyCampaignClaimSignature,
} from "@/lib/campaigns/claim-challenge";
import { deriveAddressFromPublicKey } from "@/lib/nimiq/server-crypto";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const OTHER_CAMPAIGN = "33333333-3333-4333-8333-333333333333";

function envelopeHash(message: string): Uint8Array {
  const prefix = `${String.fromCharCode(0x16)}Nimiq Signed Message:\n`;
  const payload = Buffer.concat([
    Buffer.from(prefix, "utf8"),
    Buffer.from(String(message.length), "utf8"),
    Buffer.from(message, "utf8"),
  ]);
  return new Uint8Array(createHash("sha256").update(payload).digest());
}

function freshWallet(): { address: string; publicKey: string; sign: (message: string) => string } {
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

type Row = Record<string, unknown>;

interface FakeDb {
  campaigns: Row[];
  challenges: Row[];
  inserted: Row[];
  updates: Array<{ table: string; patch: Row }>;
}

function makeAdmin(db: FakeDb) {
  const matches = (rows: Row[], filters: Array<[string, unknown]>) =>
    rows.filter((row) => filters.every(([col, val]) => row[col] === val));
  const chain = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let pendingUpdate: Row | null = null;
    let pendingInsert: Row | null = null;
    let onlyNull: string | null = null;
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return api;
      },
      is: (col: string, val: unknown) => {
        if (val === null) onlyNull = col;
        else filters.push([col, val]);
        return api;
      },
      update: (patch: Row) => {
        pendingUpdate = patch;
        db.updates.push({ table, patch });
        return api;
      },
      insert: (row: Row) => {
        pendingInsert = row;
        return api;
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        (api.maybeSingle as () => Promise<unknown>)().then(resolve, reject),
      maybeSingle: async () => {
        if (pendingUpdate) {
          for (const row of db.challenges) {
            const hit = filters.every(([col, val]) => row[col] === val) &&
              (onlyNull === null || row[onlyNull] === null || row[onlyNull] === undefined);
            if (hit) Object.assign(row, pendingUpdate);
          }
          return { data: null, error: null };
        }
        const source = table === "participation_campaigns" ? db.campaigns : db.challenges;
        const rows = matches(source, filters);
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        if (pendingInsert) {
          const row = { id: `challenge-${db.inserted.length + 1}`, consumed_at: null, ...pendingInsert };
          db.challenges.push(row);
          db.inserted.push(row);
          return { data: row, error: null };
        }
        return { data: null, error: { code: "PGRST116" } };
      },
    };
    return api;
  };
  return { from: (table: string) => chain(table) };
}

function baseDb(): FakeDb {
  return {
    campaigns: [{ id: CAMPAIGN }],
    challenges: [],
    inserted: [],
    updates: [],
  };
}

describe("buildCampaignClaimMessage", () => {
  it("is deterministic and binds campaign, wallet, action, version, nonce, window, and origin", () => {
    const input = {
      campaignId: CAMPAIGN,
      participantWallet: "01" + "a".repeat(38),
      nonce: "test-nonce",
      issuedAt: "2026-09-16T12:00:00.000Z",
      expiresAt: "2026-09-16T12:05:00.000Z",
      origin: "localhost",
    };
    const first = buildCampaignClaimMessage(input);
    const second = buildCampaignClaimMessage({ ...input });
    expect(first).toBe(second);
    for (const part of [
      CAMPAIGN,
      "01" + "a".repeat(38),
      CAMPAIGN_CLAIM_ACTION,
      String(CAMPAIGN_CLAIM_VERSION),
      "test-nonce",
      "2026-09-16T12:00:00.000Z",
      "2026-09-16T12:05:00.000Z",
      "localhost",
    ]) {
      expect(first).toContain(part);
    }
    for (const forbidden of ["luna", "vault", "settlement", "principal", "recipient", "amount"]) {
      expect(first.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe("issueCampaignClaimChallenge", () => {
  it("stores only the nonce hash and returns exactly the signing payload", async () => {
    const db = baseDb();
    const wallet = freshWallet();
    const result = await issueCampaignClaimChallenge(makeAdmin(db) as never, {
      campaignId: CAMPAIGN,
      sessionAddress: wallet.address,
    });

    expect(result.challengeId).toBeTruthy();
    expect(result.message).toContain(CAMPAIGN);
    expect(result.message).toContain(wallet.address);
    expect(Object.keys(result).sort()).toEqual(["challengeId", "expiresAt", "message"]);
    expect(JSON.stringify(result)).not.toContain("nonce_hash");
    expect(JSON.stringify(result)).not.toContain("consumed");

    expect(db.inserted).toHaveLength(1);
    const stored = db.inserted[0];
    const nonceLine = result.message.split("\n").find((line) => line.startsWith("Nonce: "));
    expect(nonceLine).toBeTruthy();
    const rawNonce = (nonceLine as string).replace("Nonce: ", "");
    expect(stored.nonce_hash).toBe(createHash("sha256").update(rawNonce, "utf8").digest("hex"));
    expect(stored.participant_wallet).toBe(wallet.address);
    expect(stored.action).toBe(CAMPAIGN_CLAIM_ACTION);
    expect(stored.version).toBe(CAMPAIGN_CLAIM_VERSION);
    expect("nonce" in stored && typeof stored.nonce === "string" ? stored.nonce : undefined).toBeUndefined();
  });

  it("leaves earlier challenges unconsumed and verifiable when a second challenge is issued", async () => {
    // Locked semantic: consumed_at means "consumed by the authoritative
    // atomic claim transaction" (slice D). Slice C never writes it, so a
    // re-issue must not invalidate the earlier challenge; both stay valid
    // until their own expiry.
    const db = baseDb();
    const wallet = freshWallet();
    const admin = makeAdmin(db) as never;
    const first = await issueCampaignClaimChallenge(admin, {
      campaignId: CAMPAIGN,
      sessionAddress: wallet.address,
    });
    const second = await issueCampaignClaimChallenge(admin, {
      campaignId: CAMPAIGN,
      sessionAddress: wallet.address,
    });

    expect(db.challenges).toHaveLength(2);
    expect(db.challenges[0].consumed_at).toBeNull();
    expect(db.challenges[1].consumed_at).toBeNull();
    expect(db.updates).toEqual([]);

    await expect(
      verifyCampaignClaimSignature(admin, {
        challengeId: first.challengeId,
        campaignId: CAMPAIGN,
        address: wallet.address,
        publicKey: wallet.publicKey,
        signature: wallet.sign(first.message),
      }),
    ).resolves.toEqual({ kind: "ok", participantWallet: wallet.address });

    await expect(
      verifyCampaignClaimSignature(admin, {
        challengeId: second.challengeId,
        campaignId: CAMPAIGN,
        address: wallet.address,
        publicKey: wallet.publicKey,
        signature: wallet.sign(second.message),
      }),
    ).resolves.toEqual({ kind: "ok", participantWallet: wallet.address });
    expect(db.updates).toEqual([]);
  });

  it("rejects unknown campaigns and malformed wallets", async () => {
    const db = baseDb();
    const admin = makeAdmin(db) as never;
    await expect(
      issueCampaignClaimChallenge(admin, { campaignId: "missing", sessionAddress: freshWallet().address }),
    ).rejects.toMatchObject({ code: "campaign_not_found" });
    await expect(
      issueCampaignClaimChallenge(admin, { campaignId: CAMPAIGN, sessionAddress: "not-a-wallet" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(db.inserted).toHaveLength(0);
  });
});

async function issuedPair(
  db: FakeDb,
  campaignId: string,
  wallet: { address: string; publicKey: string; sign: (message: string) => string },
) {
  const issued = await issueCampaignClaimChallenge(makeAdmin(db) as never, {
    campaignId,
    sessionAddress: wallet.address,
  });
  return { issued, signature: wallet.sign(issued.message) };
}

describe("verifyCampaignClaimSignature", () => {
  it("accepts a valid signature exactly for its campaign and wallet", async () => {
    const db = baseDb();
    const wallet = freshWallet();
    const { issued, signature } = await issuedPair(db, CAMPAIGN, wallet);

    const result = await verifyCampaignClaimSignature(makeAdmin(db) as never, {
      challengeId: issued.challengeId,
      campaignId: CAMPAIGN,
      address: wallet.address,
      publicKey: wallet.publicKey,
      signature,
    });
    expect(result).toEqual({ kind: "ok", participantWallet: wallet.address });
    // Verification is read-only: slice C never writes consumed_at.
    expect(db.updates).toEqual([]);
  });

  it("rejects cross-campaign and cross-wallet reuse", async () => {
    const db = baseDb();
    const wallet = freshWallet();
    const other = freshWallet();
    const { issued, signature } = await issuedPair(db, CAMPAIGN, wallet);
    const admin = makeAdmin(db) as never;

    await expect(
      verifyCampaignClaimSignature(admin, {
        challengeId: issued.challengeId,
        campaignId: OTHER_CAMPAIGN,
        address: wallet.address,
        publicKey: wallet.publicKey,
        signature,
      }),
    ).resolves.toMatchObject({ kind: "error", reasonCode: "campaign_mismatch" });

    await expect(
      verifyCampaignClaimSignature(admin, {
        challengeId: issued.challengeId,
        campaignId: CAMPAIGN,
        address: other.address,
        publicKey: other.publicKey,
        signature,
      }),
    ).resolves.toMatchObject({ kind: "error", reasonCode: "wallet_mismatch" });
  });

  it("rejects stored action/version drift as a campaign mismatch", async () => {
    const db = baseDb();
    const wallet = freshWallet();
    const { issued, signature } = await issuedPair(db, CAMPAIGN, wallet);
    const admin = makeAdmin(db) as never;

    const row = db.challenges.find((item) => item.id === issued.challengeId);
    if (!row) throw new Error("challenge fixture missing");
    row.action = "other_action";
    await expect(
      verifyCampaignClaimSignature(admin, {
        challengeId: issued.challengeId,
        campaignId: CAMPAIGN,
        address: wallet.address,
        publicKey: wallet.publicKey,
        signature,
      }),
    ).resolves.toMatchObject({ kind: "error", reasonCode: "campaign_mismatch" });

    row.action = CAMPAIGN_CLAIM_ACTION;
    row.version = 2;
    await expect(
      verifyCampaignClaimSignature(admin, {
        challengeId: issued.challengeId,
        campaignId: CAMPAIGN,
        address: wallet.address,
        publicKey: wallet.publicKey,
        signature,
      }),
    ).resolves.toMatchObject({ kind: "error", reasonCode: "campaign_mismatch" });
  });

  it("rejects tampered messages, unknown challenges, and malformed inputs", async () => {
    const db = baseDb();
    const wallet = freshWallet();
    const { issued, signature } = await issuedPair(db, CAMPAIGN, wallet);
    const admin = makeAdmin(db) as never;

    const tampered = issued.message.replace(CAMPAIGN, OTHER_CAMPAIGN);
    await expect(
      verifyCampaignClaimSignature(admin, {
        challengeId: issued.challengeId,
        campaignId: OTHER_CAMPAIGN,
        address: wallet.address,
        publicKey: wallet.publicKey,
        signature,
      }),
    ).resolves.toMatchObject({ kind: "error", reasonCode: "campaign_mismatch" });
    expect(tampered).not.toBe(issued.message);

    await expect(
      verifyCampaignClaimSignature(admin, {
        challengeId: "00000000-0000-0000-0000-000000000000",
        campaignId: CAMPAIGN,
        address: wallet.address,
        publicKey: wallet.publicKey,
        signature,
      }),
    ).resolves.toMatchObject({ kind: "error", reasonCode: "challenge_not_found" });

    await expect(
      verifyCampaignClaimSignature(admin, {
        challengeId: issued.challengeId,
        campaignId: CAMPAIGN,
        address: wallet.address,
        publicKey: wallet.publicKey,
        signature: "zzzz",
      }),
    ).resolves.toMatchObject({ kind: "error", reasonCode: "invalid_signature" });

    await expect(
      verifyCampaignClaimSignature(admin, {
        challengeId: issued.challengeId,
        campaignId: CAMPAIGN,
        address: "not-a-wallet",
        publicKey: wallet.publicKey,
        signature,
      }),
    ).resolves.toMatchObject({ kind: "error", reasonCode: "wallet_mismatch" });
  });

  it("rejects expired and already-consumed challenges without mutating them", async () => {
    const db = baseDb();
    const wallet = freshWallet();
    const admin = makeAdmin(db) as never;
    const { issued, signature } = await issuedPair(db, CAMPAIGN, wallet);

    const row = db.challenges.find((item) => item.id === issued.challengeId);
    if (!row) throw new Error("challenge fixture missing");
    row.expires_at = new Date(Date.now() - 1000).toISOString();
    await expect(
      verifyCampaignClaimSignature(admin, {
        challengeId: issued.challengeId,
        campaignId: CAMPAIGN,
        address: wallet.address,
        publicKey: wallet.publicKey,
        signature,
      }),
    ).resolves.toMatchObject({ kind: "error", reasonCode: "challenge_expired" });

    row.expires_at = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    row.consumed_at = new Date().toISOString();
    await expect(
      verifyCampaignClaimSignature(admin, {
        challengeId: issued.challengeId,
        campaignId: CAMPAIGN,
        address: wallet.address,
        publicKey: wallet.publicKey,
        signature,
      }),
    ).resolves.toMatchObject({ kind: "error", reasonCode: "challenge_consumed" });
    expect(row.consumed_at).not.toBeNull();
  });
});
