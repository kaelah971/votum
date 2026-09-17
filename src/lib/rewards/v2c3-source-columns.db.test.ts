import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createParticipationCampaign, publishParticipationCampaign } from "@/lib/campaigns/configuration";
import { beginCampaignFunding, bindCampaignFunding } from "@/lib/campaigns/funding";
import { ensureRewardSettlementVault } from "@/lib/rewards/vault-service";
import { createRewardSettlementService } from "@/lib/rewards/settlement";
import {
  createDefaultFundingConfirmationDependencies,
  loadFundingConfirmationContext,
  reconcileFundingIntent,
} from "@/lib/rewards/funding-confirmation";
import type { FundingObservation } from "@/lib/rewards/reconciliation";
import { createPollCampaignFixture, deletePollCampaignFixtureSql } from "@/lib/rewards/settlement-fixture";
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
const createdPollIds: string[] = [];
const createdPollCampaignIds: string[] = [];

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function runPsql(sql: string): void {
  execFileSync("docker", [
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-c", sql,
  ], { stdio: "pipe" });
}

function catalogOne(sql: string): string {
  return execFileSync("docker", [
    "exec", testDbContainer(), "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql,
  ], { encoding: "utf8" }).trim();
}

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

async function createCampaign(options: { maxParticipants?: number; rewardPerParticipant?: string } = {}) {
  const result = await createParticipationCampaign(OWNER, {
    type: "public_giveaway",
    title: `Source columns fixture ${hex(4)}`,
    description: null,
    visibility: "unlisted",
    startsAt: null,
    endsAt: null,
    rewardPerParticipant: options.rewardPerParticipant ?? "0.5",
    maxRewardedParticipants: options.maxParticipants ?? 10,
    fundingMode: "creator",
  });
  createdCampaignIds.push(result.campaign.campaignId);
  createdRootIds.push(result.campaign.settlementId);
  await publishParticipationCampaign(OWNER, result.campaign.campaignId);
  await ensureRewardSettlementVault(result.campaign.settlementId);
  return result.campaign;
}

async function readSettlement(settlementId: string) {
  const { data, error } = await admin.from("reward_settlements")
    .select("id, status, funded_amount_luna, refundable_excess_luna, funded_at")
    .eq("id", settlementId)
    .single();
  if (error || !data) throw error ?? new Error("settlement fixture missing");
  return data;
}

/** Server-observed finality stub: exact vault transfer with macro evidence. No chain contact. */
function observedFunding(hash: string, vaultHex: string, amountLuna: bigint, reference: string): FundingObservation {
  const block = hex(32);
  return {
    kind: "found",
    transaction: {
      transactionHash: hash,
      blockHash: block,
      networkId: 24,
      sender: OWNER,
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

async function confirmWithObservation(
  settlementId: string,
  intentId: string,
  hash: string,
  vaultHex: string,
  amountLuna: bigint,
  reference: string,
) {
  const loaded = await loadFundingConfirmationContext(admin as never, settlementId, intentId, OWNER);
  if (loaded.kind !== "ok") throw new Error(`confirm context not loadable: ${loaded.kind}`);
  const deps = createDefaultFundingConfirmationDependencies(admin as never);
  return reconcileFundingIntent(loaded.context, {
    ...deps,
    observeFundingByHash: async () => observedFunding(hash, vaultHex, amountLuna, reference),
  });
}

beforeAll(() => {
  assertLocalSupabaseForTests();
});

afterAll(() => {
  const campaigns = createdCampaignIds.map((id) => `'${id}'`).join(", ");
  const roots = createdRootIds.map((id) => `'${id}'`).join(", ");
  if (campaigns.length > 0) {
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
  }
  if (createdPollCampaignIds.length > 0) {
    runPsql(deletePollCampaignFixtureSql(createdPollCampaignIds, createdPollIds));
    createdPollCampaignIds.length = 0;
    createdPollIds.length = 0;
  }
});

describe("V2C.3D Phase 1 source compatibility migration", () => {
  it("carries nullable source columns governed by Poll/Campaign branch checks", () => {
    for (const table of ["reward_funding_transactions", "reward_receipts", "reward_refunds"]) {
      const nullable = catalogOne(`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = 'campaign_id';
      `);
      expect(nullable, `${table}.campaign_id`).toBe("YES");
    }
    const receiptsPoll = catalogOne(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'reward_receipts' AND column_name = 'poll_id';
    `);
    expect(receiptsPoll).toBe("YES");

    const checks = catalogOne(`
      SELECT string_agg(conname, ',' ORDER BY conname)
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND c.contype = 'c'
        AND t.relname IN ('reward_funding_transactions', 'reward_receipts', 'reward_refunds');
    `).split(",");
    for (const name of [
      "reward_funding_source_branch",
      "reward_receipts_source_branch",
      "reward_refunds_source_branch",
    ]) {
      expect(checks).toContain(name);
    }

    const indexes = catalogOne(`
      SELECT string_agg(indexname, ',' ORDER BY indexname)
      FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'reward_receipts';
    `).split(",");
    expect(indexes).toContain("idx_reward_receipts_settlement_wallet");

    for (const table of ["reward_funding_transactions", "reward_receipts", "reward_refunds"]) {
      expect(catalogOne(`
        SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = '${table}';
      `), `${table} RLS`).toBe("t");
    }
  });

  it("accepts Poll-shaped and Campaign-shaped receipt identities and rejects mixed shapes", async () => {
    const poll = await createPollCampaignFixture(admin as never, {});
    createdPollCampaignIds.push(poll.campaignId);
    createdPollIds.push(poll.pollId);

    const pollReceipt = await admin.from("reward_receipts").insert({
      campaign_id: poll.campaignId,
      settlement_id: poll.campaignId,
      poll_id: poll.pollId,
      participant_wallet: OWNER,
      amount_luna: 1000,
      status: "reserved",
    }).select("id").single();
    expect(pollReceipt.error).toBeNull();

    const campaign = await createCampaign();
    const campaignReceipt = await admin.from("reward_receipts").insert({
      campaign_id: null,
      settlement_id: campaign.settlementId,
      poll_id: null,
      participant_wallet: OWNER,
      amount_luna: 500000,
      status: "reserved",
    }).select("id").single();
    expect(campaignReceipt.error).toBeNull();

    const mixed = await admin.from("reward_receipts").insert({
      campaign_id: null,
      settlement_id: campaign.settlementId,
      poll_id: poll.pollId,
      participant_wallet: OWNER,
      amount_luna: 500000,
      status: "reserved",
    });
    expect(mixed.error?.code).toBe("23514");

    const missingSettlement = await admin.from("reward_receipts").insert({
      campaign_id: null,
      settlement_id: null,
      poll_id: null,
      participant_wallet: OWNER,
      amount_luna: 500000,
      status: "reserved",
    });
    expect(missingSettlement.error?.code).toBe("23502");
  });

  it("executes Campaign-branch funding end to end with settlement-authoritative rows", async () => {
    const campaign = await createCampaign();
    const started = await beginCampaignFunding(admin as never, campaign.campaignId, OWNER);
    expect(started.kind).toBe("created");
    if (started.kind !== "created") throw new Error(`begin failed: ${started.kind}`);
    const intent = started.fundingIntent;

    const { data: row } = await admin.from("reward_funding_transactions")
      .select("campaign_id, settlement_id, creator_wallet, funder_wallet, amount_luna, vault_wallet")
      .eq("id", intent.fundingIntentId)
      .single();
    expect(row?.campaign_id).toBeNull();
    expect(row?.settlement_id).toBe(campaign.settlementId);
    expect(row?.creator_wallet).toBe(OWNER);

    const replayed = await beginCampaignFunding(admin as never, campaign.campaignId, OWNER);
    expect(replayed).toMatchObject({ kind: "replay" });

    const txHash = hex(32);
    const bound = await bindCampaignFunding(admin as never, campaign.campaignId, intent.fundingIntentId, OWNER, txHash);
    expect(bound).toMatchObject({ kind: "bound", settlementId: campaign.settlementId });

    const confirmed = await confirmWithObservation(
      campaign.settlementId, intent.fundingIntentId, txHash, intent.vaultAddressHex, BigInt(intent.requiredFundingLuna), intent.reference,
    );
    expect(confirmed.kind).toBe("confirmed");

    const settled = await readSettlement(campaign.settlementId);
    expect(settled.status).toBe("funded");
    expect(BigInt(settled.funded_amount_luna)).toBe(BigInt(intent.requiredFundingLuna));
  });

  it("rejects hash reuse across settlements and underpayment without mutating state", async () => {
    const first = await createCampaign();
    const firstStarted = await beginCampaignFunding(admin as never, first.campaignId, OWNER);
    if (firstStarted.kind !== "created") throw new Error("first begin failed");
    const firstIntent = firstStarted.fundingIntent;
    const sharedHash = hex(32);
    await bindCampaignFunding(admin as never, first.campaignId, firstIntent.fundingIntentId, OWNER, sharedHash);

    const second = await createCampaign();
    const secondStarted = await beginCampaignFunding(admin as never, second.campaignId, OWNER);
    if (secondStarted.kind !== "created") throw new Error("second begin failed");
    const secondIntent = secondStarted.fundingIntent;
    const reused = await bindCampaignFunding(admin as never, second.campaignId, secondIntent.fundingIntentId, OWNER, sharedHash);
    expect(reused).toMatchObject({ kind: "error", reasonCode: "transaction_already_reserved" });

    const underpaid = await confirmWithObservation(
      first.settlementId, firstIntent.fundingIntentId, sharedHash, firstIntent.vaultAddressHex, BigInt(1), firstIntent.reference,
    );
    expect(underpaid).toMatchObject({ kind: "reconciled" });
    const stillPending = await readSettlement(first.settlementId);
    expect(stillPending.status).toBe("funding_pending");
  });

  it("accounts a confirmed overpayment as refundable excess with macro finality", async () => {
    const campaign = await createCampaign();
    const started = await beginCampaignFunding(admin as never, campaign.campaignId, OWNER);
    if (started.kind !== "created") throw new Error("begin failed");
    const intent = started.fundingIntent;
    const txHash = hex(32);
    await bindCampaignFunding(admin as never, campaign.campaignId, intent.fundingIntentId, OWNER, txHash);

    const overpaid = BigInt(intent.requiredFundingLuna) + BigInt(500);
    const confirmed = await confirmWithObservation(
      campaign.settlementId, intent.fundingIntentId, txHash, intent.vaultAddressHex, overpaid, intent.reference,
    );
    expect(confirmed.kind).toBe("confirmed");
    const settled = await readSettlement(campaign.settlementId);
    expect(settled.status).toBe("funded");
    expect(BigInt(settled.refundable_excess_luna)).toBe(BigInt(500));
  });

  it("keeps Campaign refund rows on the settlement branch without a Poll row", async () => {
    const campaign = await createCampaign();
    const inserted = await admin.from("reward_refunds").insert({
      campaign_id: null,
      settlement_id: campaign.settlementId,
      creator_wallet: OWNER,
      amount_luna: 1000,
      status: "pending",
    }).select("id").single();
    expect(inserted.error).toBeNull();
  });

  it("keeps Poll funding behavior identical at the Poll boundary", async () => {
    const poll = await createPollCampaignFixture(admin as never, {});
    createdPollCampaignIds.push(poll.campaignId);
    createdPollIds.push(poll.pollId);
    const { error: vaultError } = await admin.from("reward_campaign_vaults").insert({
      campaign_id: poll.campaignId,
      settlement_id: poll.campaignId,
      vault_address_hex: poll.creatorWallet,
      envelope_version: "votum:reward-vault:v1",
      encryption_algorithm: "aes-256-gcm",
      encrypted_private_key_ciphertext: "fixture-ciphertext",
      encryption_iv: "fixture-iv",
      authentication_tag: "fixture-tag",
    });
    expect(vaultError).toBeNull();

    const service = createRewardSettlementService(admin as never);
    const started = await service.beginFunding(poll.campaignId, poll.creatorWallet);
    expect(started.kind).toBe("created");
    if (started.kind !== "created") throw new Error("poll begin failed");
    expect(started.fundingIntent.campaignId).toBe(poll.campaignId);

    const unknown = await service.beginFunding(randomUUID(), poll.creatorWallet);
    expect(unknown).toMatchObject({ kind: "error", reasonCode: "campaign_not_found" });
  });

  it("exposes one settlement-canonical funding contract with no fork or Poll overload", () => {
    const args = (fn: string) => catalogOne(`
      SELECT string_agg(pg_get_function_arguments(oid), ';' ORDER BY oid)
      FROM pg_proc WHERE proname = '${fn}' AND pronamespace = 'public'::regnamespace;
    `);
    expect(args("begin_reward_funding_atomic")).toContain("_settlement_id");
    expect(args("begin_reward_funding_atomic")).not.toContain("_campaign_id");
    expect(args("bind_reward_funding_transaction_atomic")).toContain("_settlement_id");
    expect(args("confirm_reward_funding_atomic")).toContain("_settlement_id");

    expect(catalogOne(`
      SELECT count(*) FROM pg_proc
      WHERE proname IN ('begin_campaign_funding_atomic', 'bind_campaign_funding_transaction_atomic', 'confirm_campaign_funding_atomic')
        AND pronamespace = 'public'::regnamespace;
    `)).toBe("0");

    expect(catalogOne(`
      SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'reward_funding_transactions'
        AND column_name = 'participation_campaign_id';
    `)).toBe("0");

    for (const [relative, oldLiteral, newLiteral] of [
      ["src/lib/rewards/settlement.ts", "_campaign_id: settlementId", "_settlement_id: settlementId"],
      ["src/lib/rewards/funding-confirmation.ts", "_campaign_id: input.campaignId", "_settlement_id: input.campaignId"],
      ["src/lib/rewards/settlement.test.ts", "_campaign_id: SETTLEMENT_ID", "_settlement_id: SETTLEMENT_ID"],
      ["src/lib/campaigns/funding.test.ts", "_campaign_id: SETTLEMENT", "_settlement_id: SETTLEMENT"],
      ["src/lib/rewards/funding-confirmation.db.test.ts", "_campaign_id: overrides", "_settlement_id: overrides"],
    ] as const) {
      const content = source(relative);
      expect(content.includes(oldLiteral), `${relative} still invokes a funding RPC with ${oldLiteral}`).toBe(false);
      expect(content.includes(newLiteral), `${relative} missing ${newLiteral}`).toBe(true);
    }
  });
});
