/**
 * V2B.2.2B — Persisted campaign-vault DB contract tests.
 *
 * Proves the reward_campaign_vaults schema boundary at the database layer:
 * table/columns/constraints exist, RLS blocks anon/authenticated, the atomic
 * ensure RPC is idempotent + race-safe and enforces campaign state, and no
 * encrypted fields leak through public surfaces.
 *
 * Crypto/service behaviour is covered by `src/lib/rewards/vault-service.test.ts`
 * (this script cannot import server-only modules — tsx does not resolve the
 * Next `server-only` alias).
 *
 * Usage:
 *   npx tsx src/lib/api/v2b2-vault-test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "./load-local-env";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const pubKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});
const anon = createClient(url, pubKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

function ensureLocal(): void {
  if (!url || url.includes(".supabase.co")) {
    throw new Error("refusing hosted Supabase target");
  }
}

function uuid(): string {
  return randomBytes(16).toString("hex").replace(
    /(.{8})(.{4})(.{4})(.{4})(.{12})/,
    "$1-$2-$3-$4-$5",
  );
}

const CREATOR = "01" + randomBytes(19).toString("hex");
const campaignIds: string[] = [];

function cleanupSql(): void {
  ensureLocal();
  const sql = `
    DELETE FROM public.reward_campaign_vaults
      WHERE campaign_id IN (SELECT id FROM public.reward_campaigns
        WHERE poll_id IN (SELECT id FROM public.polls
          WHERE question = 'V2B2 vault db contract test?'));
    DELETE FROM public.reward_campaigns
      WHERE poll_id IN (SELECT id FROM public.polls
        WHERE question = 'V2B2 vault db contract test?');
    DELETE FROM public.poll_publication_requests
      WHERE poll_id IN (SELECT id FROM public.polls WHERE question = 'V2B2 vault db contract test?');
    DELETE FROM public.poll_options
      WHERE poll_id IN (SELECT id FROM public.polls WHERE question = 'V2B2 vault db contract test?');
    DELETE FROM public.poll_votes
      WHERE poll_id IN (SELECT id FROM public.polls WHERE question = 'V2B2 vault db contract test?');
    DELETE FROM public.polls WHERE question = 'V2B2 vault db contract test?';
  `;
  execFileSync("docker", [
    "exec", "supabase_db_votum",
    "psql", "-U", "postgres", "-d", "postgres",
    "-c", sql,
  ], { stdio: "pipe" });
  campaignIds.length = 0;
}

async function publishPoll(): Promise<string> {
  const q = "V2B2 vault db contract test?";
  const opts = ["A", "B"];
  const fp = createHash("sha256")
    .update(JSON.stringify({
      question: q, description: null, options: opts, mode: "creator_support",
      destinationWallet: CREATOR, destinationPurpose: "vault db test",
      minimumNimLuna: "100000", fairnessMode: "one_wallet_one_vote", duration: "1day",
    }))
    .digest("hex");
  const r = await admin.rpc("publish_poll_atomic", {
    _creator_wallet: CREATOR,
    _question: q,
    _description: null,
    _mode: "creator_support",
    _destination_wallet: CREATOR,
    _destination_purpose: "vault db test",
    _min_nim_luna: 100000,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 86400000).toISOString(),
    _options: opts,
    _idempotency_key: uuid(),
    _request_fingerprint: fp,
  });
  if (r.error) throw r.error;
  return (r.data as { id: string }).id as string;
}

async function createCampaign(status: string = "configured"): Promise<string> {
  const pollId = await publishPoll();
  const { data, error } = await admin.from("reward_campaigns").insert({
    poll_id: pollId,
    creator_wallet: CREATOR,
    reward_per_participant_luna: 1000,
    max_rewarded_participants: 10,
    reward_principal_luna: 10000,
    fee_reserve_luna: 0,
    total_budget_luna: 10000,
    status,
  }).select("id").single();
  if (error) throw error;
  const id = (data as { id: string }).id;
  campaignIds.push(id);
  return id;
}

const DUMMY = {
  _vault_address_hex: "ab".repeat(20),
  _envelope_version: "votum:reward-vault:v1",
  _encryption_algorithm: "aes-256-gcm",
  _ciphertext: Buffer.from(randomBytes(32)).toString("base64"),
  _iv: Buffer.from(randomBytes(12)).toString("base64"),
  _auth_tag: Buffer.from(randomBytes(16)).toString("base64"),
};

async function run() {
  ensureLocal();
  console.log("V2B.2.2B Persisted Vault DB Contract Suite");

  // ---- Table + columns + constraints exist ----
  console.log("\n-- Schema --");
  const tbl = await admin.from("reward_campaign_vaults").select("campaign_id").limit(1);
  check(!tbl.error || tbl.error.code === "PGRST116", "reward_campaign_vaults table queryable");

  const badAddr = await admin.from("reward_campaign_vaults").insert({
    campaign_id: (await createCampaign()),
    vault_address_hex: "not-hex",
    envelope_version: "votum:reward-vault:v1",
    encryption_algorithm: "aes-256-gcm",
    encrypted_private_key_ciphertext: "x",
    encryption_iv: "y",
    authentication_tag: "z",
  }).select("campaign_id");
  check(badAddr.error !== null, "non-hex vault address rejected (CHECK)");
  campaignIds.pop();

  const badVersion = await admin.from("reward_campaign_vaults").insert({
    campaign_id: (await createCampaign()),
    vault_address_hex: "ab".repeat(20),
    envelope_version: "v999",
    encryption_algorithm: "aes-256-gcm",
    encrypted_private_key_ciphertext: "x",
    encryption_iv: "y",
    authentication_tag: "z",
  }).select("campaign_id");
  check(badVersion.error !== null, "unknown envelope version rejected (CHECK)");
  campaignIds.pop();

  const badAlgo = await admin.from("reward_campaign_vaults").insert({
    campaign_id: (await createCampaign()),
    vault_address_hex: "ab".repeat(20),
    envelope_version: "votum:reward-vault:v1",
    encryption_algorithm: "aes-128-cbc",
    encrypted_private_key_ciphertext: "x",
    encryption_iv: "y",
    authentication_tag: "z",
  }).select("campaign_id");
  check(badAlgo.error !== null, "unsupported algorithm rejected (CHECK)");
  campaignIds.pop();

  const emptyCipher = await admin.from("reward_campaign_vaults").insert({
    campaign_id: (await createCampaign()),
    vault_address_hex: "ab".repeat(20),
    envelope_version: "votum:reward-vault:v1",
    encryption_algorithm: "aes-256-gcm",
    encrypted_private_key_ciphertext: "   ",
    encryption_iv: "y",
    authentication_tag: "z",
  }).select("campaign_id");
  check(emptyCipher.error !== null, "empty ciphertext rejected (CHECK)");
  campaignIds.pop();

  // ---- Atomic ensure RPC: create + idempotent + race + state gate ----
  console.log("\n-- Atomic ensure RPC --");
  const campCreated = await createCampaign("configured");
  const r1 = await admin.rpc("ensure_reward_campaign_vault_atomic", {
    _campaign_id: campCreated, ...DUMMY,
  });
  check((r1.data as any)?.result_kind === "created", "first ensure → created");

  const r2 = await admin.rpc("ensure_reward_campaign_vault_atomic", {
    _campaign_id: campCreated, ...DUMMY,
  });
  check((r2.data as any)?.result_kind === "existing", "second ensure → existing");

  const race = await Promise.all([
    admin.rpc("ensure_reward_campaign_vault_atomic", { _campaign_id: campCreated, ...DUMMY }),
    admin.rpc("ensure_reward_campaign_vault_atomic", { _campaign_id: campCreated, ...DUMMY }),
  ]);
  const kinds = race.map((r) => (r.data as any)?.result_kind);
  check(kinds.every((k) => k === "existing"), "concurrent ensure → both existing");
  const rowCount = await admin.from("reward_campaign_vaults")
    .select("campaign_id")
    .eq("campaign_id", campCreated);
  check((rowCount.data ?? []).length === 1, "exactly one persisted vault row");

  const campBlocked = await createCampaign("funded");
  const blocked = await admin.rpc("ensure_reward_campaign_vault_atomic", {
    _campaign_id: campBlocked, ...DUMMY,
  });
  check((blocked.data as any)?.result_kind === "campaign_state_invalid", "funded campaign → state_invalid");

  const campMissing = uuid();
  const missing = await admin.rpc("ensure_reward_campaign_vault_atomic", {
    _campaign_id: campMissing, ...DUMMY,
  });
  check((missing.data as any)?.result_kind === "campaign_not_found", "unknown campaign → not_found");

  // ---- RLS ----
  console.log("\n-- RLS --");
  const anonSelect = await anon.from("reward_campaign_vaults").select("*").limit(1);
  check(anonSelect.error !== null, "anon cannot SELECT reward_campaign_vaults");

  // ---- Public RPC isolation ----
  console.log("\n-- Public RPC isolation --");
  const pollId = (await admin.from("reward_campaigns")
    .select("poll_id")
    .eq("id", campCreated)
    .single()).data?.poll_id as string;
  const pub = await anon.rpc("get_public_reward_campaign", { _poll_id: pollId });
  const pubJson = JSON.stringify(pub.data);
  check(pub.error === null, "public reward RPC callable by anon");
  check(pubJson.includes("ciphertext") === false, "no ciphertext in public RPC");
  check(pubJson.includes("encrypted_private_key") === false, "no encrypted key in public RPC");
  check(pubJson.includes("vault") === false, "no vault fields in public RPC");

  cleanupSql();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("FATAL:", e);
  try { cleanupSql(); } catch { /* best effort */ }
  process.exit(1);
});
