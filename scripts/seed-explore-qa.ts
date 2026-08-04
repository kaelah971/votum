/**
 * Local-only V2A.5 Explore QA fixture seeder.
 *
 * Creates 6 public polls across all categories and formats, spanning
 * all three Explore sections (Closing soon, Live now, Recently closed).
 *
 * Usage:
 *   npx tsx scripts/seed-explore-qa.ts
 *
 * Cleanup:
 *   npx tsx scripts/seed-explore-qa.ts --cleanup
 *
 * Safety: refuses to run against hosted (*.supabase.co) targets.
 * Idempotent: skips polls whose question starts with "[LOCAL QA]".
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";

import "@/lib/api/load-local-env";

// ---------------------------------------------------------------------------
// Local guard
// ---------------------------------------------------------------------------

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;

if (!url || !key) {
  console.error("\n\x1b[31mMissing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY.\x1b[0m");
  console.error("Set them in .env.local for local development.\n");
  process.exit(1);
}

if (url.includes(".supabase.co")) {
  console.error("\n\x1b[31mREFUSED: Target is hosted Supabase (*.supabase.co).\x1b[0m");
  console.error("This script only runs against local (127.0.0.1 / localhost / ::1).\n");
  process.exit(1);
}

console.log(`\nTarget: ${new URL(url).hostname} (local)\n`);

const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

// ---------------------------------------------------------------------------
// Fingerprint helper (mirrors publish route)
// ---------------------------------------------------------------------------

function buildFingerprint(payload: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(payload).sort()) sorted[k] = payload[k];
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREFIX = "[LOCAL QA]";
const CREATOR = "NQ07 QA FIXTURES WALLET 001";
const NOW = Date.now();

interface FixtureSpec {
  question: string;
  category: string;
  format: string;
  status: "live" | "closed";
  endsAt: string;
  options: string[];
}

const FIXTURES: FixtureSpec[] = [
  {
    question: `${PREFIX} Sports: who will win the next match?`,
    category: "sports",
    format: "prediction",
    status: "live",
    endsAt: new Date(NOW + 24 * 3600000).toISOString(),
    options: ["Team Alpha", "Team Bravo", "Draw"],
  },
  {
    question: `${PREFIX} Entertainment: best performer of the festival?`,
    category: "entertainment",
    format: "fan_vote",
    status: "live",
    endsAt: new Date(NOW + 96 * 3600000).toISOString(),
    options: ["Act One", "Act Two", "Act Three"],
  },
  {
    question: `${PREFIX} Brands: which feature should we prioritize?`,
    category: "brands_products",
    format: "decision",
    status: "live",
    endsAt: new Date(NOW + 120 * 3600000).toISOString(),
    options: ["Dark mode", "Faster exports", "Mobile app"],
  },
  {
    question: `${PREFIX} Communities: nominate the next council member.`,
    category: "communities",
    format: "nomination",
    status: "closed",
    endsAt: new Date(NOW - 48 * 3600000).toISOString(),
    options: ["Candidate X", "Candidate Y"],
  },
  {
    question: `${PREFIX} Other: what should happen next in the story?`,
    category: "other",
    format: "audience_choice",
    status: "live",
    endsAt: new Date(NOW + 48 * 3600000).toISOString(),
    options: ["Plot twist", "Happy ending", "Cliffhanger"],
  },
  {
    question: `${PREFIX} Sports: rank the all-time greatest players.`,
    category: "sports",
    format: "ranking",
    status: "closed",
    endsAt: new Date(NOW - 24 * 3600000).toISOString(),
    options: ["Player A", "Player B", "Player C", "Player D"],
  },
];

// ---------------------------------------------------------------------------
// Publish helpers
// ---------------------------------------------------------------------------

async function publishFixture(spec: FixtureSpec): Promise<"created" | "skipped" | "error"> {
  if (spec.status === "closed") {
    return insertClosedFixture(spec);
  }
  return publishLiveFixture(spec);
}

async function publishLiveFixture(spec: FixtureSpec): Promise<"created" | "skipped" | "error"> {
  const dur = "7days";
  const fp = buildFingerprint({
    category: spec.category,
    format: spec.format,
    question: spec.question,
    description: null,
    options: spec.options,
    mode: "creator_support",
    destinationWallet: CREATOR,
    destinationPurpose: "local qa fixture",
    minimumNimLuna: "10",
    fairnessMode: "one_wallet_one_vote",
    duration: dur,
  });

  const idemKey = randomBytes(16).toString("hex");

  const { data, error } = await (admin as any).rpc("publish_poll_atomic", {
    _creator_wallet: CREATOR,
    _question: spec.question,
    _description: null,
    _mode: "creator_support",
    _destination_wallet: CREATOR,
    _destination_purpose: "local qa fixture",
    _min_nim_luna: 10,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: spec.endsAt,
    _options: spec.options,
    _idempotency_key: idemKey,
    _request_fingerprint: fp,
    _category: spec.category,
    _format: spec.format,
  } as any);

  if (error) {
    console.error(`  \x1b[31mRPC error:\x1b[0m ${error.message}`);
    return "error";
  }

  if (data.result_kind === "created") {
    console.log(`  \x1b[32mCreated\x1b[0m  ${spec.question}`);
    return "created";
  }

  console.log(`  \x1b[33mSkipped\x1b[0m ${spec.question}`);
  return "skipped";
}

async function insertClosedFixture(spec: FixtureSpec): Promise<"created" | "skipped" | "error"> {
  const endedAt = new Date(spec.endsAt).toISOString();
  const startAt = new Date(new Date(spec.endsAt).getTime() - 7 * 86400000).toISOString();

  const { data: poll, error: pollErr } = await admin
    .from("polls")
    .insert({
      category: spec.category,
      format: spec.format,
      created_at: startAt,
      updated_at: endedAt,
      creator_wallet: CREATOR,
      question: spec.question,
      mode: "creator_support",
      destination_wallet: CREATOR,
      destination_purpose: "local qa fixture",
      min_nim_luna: 10,
      fairness_mode: "one_wallet_one_vote",
      status: "closed",
      starts_at: startAt,
      ends_at: endedAt,
      is_public: true,
      published_at: startAt,
    })
    .select("id")
    .single();

  if (pollErr) {
    console.error(`  \x1b[31mInsert error:\x1b[0m ${pollErr.message}`);
    return "error";
  }

  const pollId = poll.id;

  for (let i = 0; i < spec.options.length; i++) {
    const { error: optErr } = await admin.from("poll_options").insert({
      poll_id: pollId,
      label: spec.options[i],
      sort_order: i,
    });
    if (optErr) {
      console.error(`  \x1b[31mOption error:\x1b[0m ${optErr.message}`);
      return "error";
    }
  }

  console.log(`  \x1b[32mCreated\x1b[0m  ${spec.question}`);
  return "created";
}

// ---------------------------------------------------------------------------
// Check existing
// ---------------------------------------------------------------------------

async function existingQuestions(): Promise<Set<string>> {
  const { data, error } = await admin
    .from("polls")
    .select("question")
    .eq("creator_wallet", CREATOR);
  if (error) {
    console.error("Failed to check existing fixtures:", error.message);
    return new Set();
  }
  return new Set((data ?? []).map((r) => r.question));
}

// ---------------------------------------------------------------------------
// Cleanup — uses psql directly because REST API DELETE is revoked by RLS
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  console.log("Cleaning up [LOCAL QA] fixtures...\n");

  // Count first
  const { data: polls } = await admin
    .from("polls")
    .select("id")
    .eq("creator_wallet", CREATOR);

  const count = (polls ?? []).length;
  if (count === 0) {
    console.log("  No fixtures found.\n");
    return;
  }

  const sql = `
    DELETE FROM public.poll_options
      WHERE poll_id IN (SELECT id FROM public.polls WHERE creator_wallet = '${CREATOR}');
    DELETE FROM public.poll_publication_requests
      WHERE creator_wallet = '${CREATOR}';
    DELETE FROM public.polls
      WHERE creator_wallet = '${CREATOR}';
  `;

  try {
    execFileSync("docker", [
      "exec", "supabase_db_votum",
      "psql", "-U", "postgres", "-d", "postgres",
      "-c", sql,
    ], { stdio: "pipe" });
    console.log(`  \x1b[32mRemoved ${count} fixture(s).\x1b[0m\n`);
  } catch (err: any) {
    console.error(`  \x1b[31mCleanup failed:\x1b[0m ${err.stderr?.toString() ?? String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const mode = process.argv.includes("--cleanup") ? "cleanup" : "seed";

  if (mode === "cleanup") {
    await cleanup();
    return;
  }

  const existing = await existingQuestions();
  const toCreate = FIXTURES.filter((f) => !existing.has(f.question));

  if (toCreate.length === 0) {
    console.log(`\x1b[32mAll ${FIXTURES.length} [LOCAL QA] fixtures already exist. Nothing to do.\x1b[0m\n`);
    return;
  }

  if (existing.size > 0) {
    console.log(`\x1b[33m${existing.size} fixture(s) already exist. Creating ${toCreate.length} remaining.\x1b[0m\n`);
  }

  console.log(`Seeding ${toCreate.length} Explore QA fixtures...\n`);

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const spec of toCreate) {
    const result = await publishFixture(spec);
    if (result === "created") created++;
    else if (result === "skipped") skipped++;
    else errors++;
  }

  console.log(`\n\x1b[32m${created} created\x1b[0m  \x1b[33m${skipped} skipped\x1b[0m  \x1b[31m${errors} errors\x1b[0m`);
  console.log("\nVisit: http://localhost:3000/explore\n");
}

main().catch((err) => {
  console.error("\n\x1b[31mFatal:\x1b[0m", err);
  process.exit(1);
});
