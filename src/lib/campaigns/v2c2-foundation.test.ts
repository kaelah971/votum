/**
 * V2C.2F — static Campaign foundation and root-cutover gate.
 *
 * File-evidence companion to the DB suites: pins the exact migration
 * sequence, the reconciliation slot, the 85000 transaction portability fix,
 * and the no-claim/no-second-ledger boundaries directly from repository
 * source. No database required.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const MIGRATIONS_DIR = resolve(ROOT, "supabase/migrations");

const V2C2_SEQUENCE = [
  "20260913080000_v2c2_reward_settlements.sql",
  "20260913081000_v2c2_poll_settlement_backfill.sql",
  "20260913082000_v2c2_settlement_child_references.sql",
  "20260913083000_v2c2_participation_campaigns.sql",
  "20260913084000_v2c2_campaign_settlement_binding.sql",
  "20260913084500_v2b2_reconcile_refund_prepared_field_invariant.sql",
  "20260913085000_v2c2_financial_root_cutover.sql",
  "20260913086000_v2c2_poll_read_root_cutover.sql",
];

const V2C2_PRODUCT_MIGRATIONS = V2C2_SEQUENCE.filter(
  (name) => !name.includes("reconcile_refund_prepared_field_invariant"),
);

function migration(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
}

function v2c2Source(): string {
  return V2C2_PRODUCT_MIGRATIONS.map(migration).join("\n");
}

describe("V2C.2F migration sequence", () => {
  it("contains exactly the seven V2C.2 migrations plus the slotted reconciliation", () => {
    const present = readdirSync(MIGRATIONS_DIR)
      .filter((name) => /^20260913\d{6}_/.test(name))
      .sort();
    expect(present).toEqual(V2C2_SEQUENCE);
  });

  it("slots the refund reconciliation strictly between binding and cutover", () => {
    const names = readdirSync(MIGRATIONS_DIR).sort();
    const binding = names.indexOf("20260913084000_v2c2_campaign_settlement_binding.sql");
    const reconciliation = names.indexOf(
      "20260913084500_v2b2_reconcile_refund_prepared_field_invariant.sql",
    );
    const cutover = names.indexOf("20260913085000_v2c2_financial_root_cutover.sql");
    expect(binding).toBeGreaterThanOrEqual(0);
    expect(reconciliation).toBeGreaterThan(binding);
    expect(cutover).toBeGreaterThan(reconciliation);
  });

  it("has no stale 87000–90000 source files", () => {
    const stale = readdirSync(MIGRATIONS_DIR).filter((name) =>
      /^202609130(87|88|89|90)\d{3}_/.test(name),
    );
    expect(stale).toEqual([]);
  });

  it("wraps the financial cutover in an explicit transaction for runner portability", () => {
    const sql = migration("20260913085000_v2c2_financial_root_cutover.sql");
    const statements = sql
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("--"));
    expect(statements[0]).toBe("BEGIN;");
    expect(statements[statements.length - 1]).toBe("COMMIT;");
    expect(sql).toMatch(/LOCK TABLE public\.reward_campaigns,/);
  });
});

describe("V2C.2F no-claim / no-second-ledger boundaries", () => {
  it("creates exactly the three foundation tables and no financial ledgers", () => {
    const created = [...v2c2Source().matchAll(/CREATE TABLE\s+public\.(\w+)/gi)].map(
      (match) => match[1],
    );
    expect([...new Set(created)].sort()).toEqual([
      "participation_campaigns",
      "reward_settlements",
      "settlement_source_bindings",
    ]);
  });

  it("stores no claimable product state and no strategy storage", () => {
    expect(v2c2Source()).not.toMatch(/claimable/i);
    expect(v2c2Source()).not.toMatch(/secret_drop_secret|allowlist|event_proof|membership/i);
    expect(v2c2Source()).not.toMatch(/CREATE TABLE\s+public\.reward_(receipts|payout|refund)/i);
    expect(v2c2Source()).not.toMatch(/CREATE TABLE\s+public\.reward_campaign_vaults/i);
  });

  it("keeps reward_campaigns.poll_id NOT NULL UNIQUE untouched", () => {
    expect(v2c2Source()).not.toMatch(/ALTER TABLE\s+public\.reward_campaigns\s+ALTER COLUMN\s+poll_id\s+DROP NOT NULL/i);
    expect(v2c2Source()).not.toMatch(/DROP CONSTRAINT[^\n]*poll_id/i);
  });

  it("performs no direct financial write to reward_campaigns in the cutover", () => {
    const lines = migration("20260913085000_v2c2_financial_root_cutover.sql").split("\n");
    const writers = lines.filter(
      (line) =>
        !line.trim().startsWith("--") &&
        /^\s*UPDATE\s+(public\.)?reward_campaigns\b/i.test(line),
    );
    expect(writers).toEqual([]);
  });

  it("defines exactly the five approved campaign type literals", () => {
    const sql = migration("20260913083000_v2c2_participation_campaigns.sql");
    for (const literal of [
      "public_giveaway",
      "secret_drop",
      "private_drop",
      "event_drop",
      "community_reward",
    ]) {
      expect(sql).toContain(`'${literal}'`);
    }
  });
});
