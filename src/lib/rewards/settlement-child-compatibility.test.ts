import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath = "supabase/migrations/20260913082000_v2c2_settlement_child_references.sql";

describe("V2C.2B settlement child migration contract", () => {
  it("adds only the approved settlement references and preserves old authority", () => {
    const migration = readFileSync(migrationPath, "utf8");

    for (const table of [
      "reward_funding_transactions",
      "reward_receipts",
      "reward_refunds",
      "reward_campaign_vaults",
    ]) {
      expect(migration).toMatch(new RegExp(
        `ALTER TABLE public\\.${table}[\\s\\S]*?settlement_id uuid`,
        "i",
      ));
    }

    expect(migration).not.toMatch(/reward_payout_attempts[\s\S]*settlement_id/i);
    expect(migration).not.toMatch(/DROP\s+(COLUMN|CONSTRAINT|TABLE)|RENAME\s+COLUMN/i);
    expect(migration).toMatch(/reward_funding_transactions[\s\S]*ALTER COLUMN settlement_id SET NOT NULL/i);
    expect(migration).toMatch(/reward_receipts[\s\S]*ALTER COLUMN settlement_id SET NOT NULL/i);
    expect(migration).toMatch(/reward_refunds[\s\S]*ALTER COLUMN settlement_id SET NOT NULL/i);
    expect(migration).not.toMatch(/ALTER TABLE public\.reward_campaign_vaults[^;]*ALTER COLUMN settlement_id SET NOT NULL/i);
    expect(migration).toMatch(/UPDATE\s+public\.reward_campaign_vaults[\s\S]*SET\s+settlement_id\s*=\s*campaign_id/i);
    expect(migration).not.toMatch(/UPDATE\s+public\.reward_campaign_vaults[\s\S]*SET\s+(vault_address_hex|envelope_version|encryption_algorithm|encrypted_private_key_ciphertext|encryption_iv|authentication_tag)/i);
    expect(migration).not.toMatch(/participation_campaigns|claim|allowlist|event_proof|community_membership/i);
  });

  it("keeps the current campaign-keyed vault service and payout traversal", () => {
    const vaultService = readFileSync("src/lib/rewards/vault-service.ts", "utf8");
    const payout = readFileSync("src/lib/rewards/payout.ts", "utf8");

    expect(vaultService).toMatch(/from\("reward_campaign_vaults"\)[\s\S]*eq\("campaign_id", campaignId\)/);
    expect(vaultService).toMatch(/aadFor\(campaignId, row\.vault_address_hex\)/);
    expect(payout).toMatch(/from\("reward_receipts"\)/);
    expect(payout).toMatch(/from\("reward_campaign_vaults"\)[\s\S]*eq\("campaign_id", receipt\.campaign_id\)/);
    expect(payout).not.toMatch(/from\("reward_payout_attempts"\)[\s\S]*settlement_id/);
  });
});
