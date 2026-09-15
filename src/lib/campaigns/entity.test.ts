import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const campaignMigration = "supabase/migrations/20260913083000_v2c2_participation_campaigns.sql";
const bindingMigration = "supabase/migrations/20260913084000_v2c2_campaign_settlement_binding.sql";

describe("V2C.2C Campaign foundation contract", () => {
  it("defines the approved product-only schema and lifecycle", () => {
    const migration = readFileSync(campaignMigration, "utf8");
    expect(migration).toMatch(/CREATE TABLE public\.participation_campaigns/i);
    for (const column of [
      "id", "settlement_id", "owner_wallet", "campaign_type", "visibility",
      "title", "description", "status", "configuration_version",
      "published_configuration_version", "starts_at", "ends_at", "close_reason",
      "configuration_locked_at", "published_at", "closed_at", "created_at", "updated_at",
    ]) {
      expect(migration).toMatch(new RegExp(`\\b${column}\\b`, "i"));
    }
    expect(migration).toMatch(/status\s+text\s+NOT NULL\s+DEFAULT\s+'draft'/i);
    expect(migration).toMatch(/status IN \('draft', 'published', 'closed', 'expired', 'cancelled'\)/i);
    expect(migration).not.toMatch(/\bclaimable\b|\bsecret\s+text\b|\ballowlist\b|\bevent_proof\b|\bcommunity_membership\b|\bvault\b|\breceipt\b|\bpayout\b|\brefund\b/i);
  });

  it("defines the exact five types and only public giveaways as publishable", () => {
    const types = readFileSync("src/lib/campaigns/types.ts", "utf8");
    expect(types).toMatch(/public_giveaway/);
    expect(types).toMatch(/secret_drop/);
    expect(types).toMatch(/private_drop/);
    expect(types).toMatch(/event_drop/);
    expect(types).toMatch(/community_reward/);
    expect(types).toMatch(/draft/);
    expect(types).toMatch(/published/);
    expect(types).toMatch(/closed/);
    expect(types).toMatch(/expired/);
    expect(types).toMatch(/cancelled/);
    expect(types).not.toMatch(/claimable/);
  });

  it("adds the Campaign binding branch without starting a Campaign API", () => {
    const migration = readFileSync(bindingMigration, "utf8");
    expect(migration).toMatch(/participation_campaign_id/i);
    expect(migration).toMatch(/source_type.*participation_campaign/i);
    expect(migration).toMatch(/create_participation_campaign_atomic/i);
    expect(migration).toMatch(/update_participation_campaign_draft_atomic/i);
    expect(migration).toMatch(/publish_participation_campaign_atomic/i);
    expect(existsSync("src/app/api/campaigns")).toBe(false);
  });
});
