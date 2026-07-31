/**
 * Creator intelligence integration test.
 *
 * Tests the `get_creator_intelligence` RPC function directly against
 * the Supabase database using the service_role key. Validates summary
 * metrics, per-poll breakdowns, activity feed correctness, creator
 * isolation, voter-wallet privacy, and that the public client is
 * denied access.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx src/lib/api/intelligence-test.ts
 *
 * Requires these environment variables (available via .env.local):
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SECRET_KEY
 *   - NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// ── Client setup ───────────────────────────────────────────────────
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SECRET_KEY!;
const pubKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

const admin = createClient(url, key, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  db: { schema: "public" },
});

const pubClient = createClient(url, pubKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  db: { schema: "public" },
});

// ── Helpers ────────────────────────────────────────────────────────

/** Generate a deterministic content fingerprint for idempotent publish. */
function fp(q: string, o: string[]): string {
  const payload = {
    question: q,
    description: null,
    options: o,
    mode: "creator_support",
    destinationWallet: creatorA,
    destinationPurpose: "test",
    minimumNimLuna: "100000",
    fairnessMode: "one_wallet_one_vote",
    duration: "7days",
  };
  return createHash("sha256")
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest("hex");
}

/** Generate a deterministic content fingerprint for creator B. */
function fpB(q: string, o: string[], creator: string): string {
  const payload = {
    question: q,
    description: null,
    options: o,
    mode: "creator_support",
    destinationWallet: creator,
    destinationPurpose: "test",
    minimumNimLuna: "100000",
    fairnessMode: "one_wallet_one_vote",
    duration: "7days",
  };
  return createHash("sha256")
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest("hex");
}

function uuid(): string {
  return randomBytes(16)
    .toString("hex")
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

// ── Test wallets ───────────────────────────────────────────────────
const creatorA = "aaaa" + "0".repeat(38);
const creatorB = "bbbb" + "0".repeat(38);

async function main(): Promise<void> {
  // ═════════════════════════════════════════════════════════════════
  // Setup: publish polls and cast votes
  // ═════════════════════════════════════════════════════════════════

  // Publish creator A's live poll (3 options)
  const { data: p1 } = (await admin.rpc("publish_poll_atomic", {
    _creator_wallet: creatorA,
    _question: "Creator A live poll?",
    _description: null,
    _mode: "creator_support",
    _destination_wallet: creatorA,
    _destination_purpose: "test",
    _min_nim_luna: 100000,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    _options: ["Alpha", "Beta", "Gamma"],
    _idempotency_key: uuid(),
    _request_fingerprint: fp("Creator A live poll?", ["Alpha", "Beta", "Gamma"]),
  })) as any;
  const pollAId = p1.id as string;

  // Publish creator B's poll (2 options)
  const { data: p2 } = (await admin.rpc("publish_poll_atomic", {
    _creator_wallet: creatorB,
    _question: "Creator B poll?",
    _description: null,
    _mode: "creator_support",
    _destination_wallet: creatorB,
    _destination_purpose: "test",
    _min_nim_luna: 100000,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    _options: ["X", "Y"],
    _idempotency_key: uuid(),
    _request_fingerprint: fpB("Creator B poll?", ["X", "Y"], creatorB),
  })) as any;
  const pollBId = p2.id as string;

  // Get option IDs
  const { data: optsA } = await admin
    .from("poll_options")
    .select("id,label")
    .eq("poll_id", pollAId)
    .order("sort_order");
  const [optA1, optA2] = optsA!;

  // Cast votes on poll A (3 votes across 2 options)
  await admin.rpc("cast_poll_vote_atomic", {
    _poll_id: pollAId,
    _option_id: optA1.id,
    _voter_wallet: "voter1" + "0".repeat(36),
  });
  await admin.rpc("cast_poll_vote_atomic", {
    _poll_id: pollAId,
    _option_id: optA1.id,
    _voter_wallet: "voter2" + "0".repeat(36),
  });
  await admin.rpc("cast_poll_vote_atomic", {
    _poll_id: pollAId,
    _option_id: optA2.id,
    _voter_wallet: "voter3" + "0".repeat(36),
  });

  // ═════════════════════════════════════════════════════════════════
  // Test 1: Creator A intelligence — summary metrics
  // ═════════════════════════════════════════════════════════════════
  console.log("─── Test 1: Creator A intelligence ───");
  const { data: intel, error: intelErr } = (await admin.rpc(
    "get_creator_intelligence",
    { _creator_wallet: creatorA } as any,
  )) as any;
  assert(!intelErr, `RPC failed: ${intelErr?.message}`);
  const result = intel as any;

  // Summary checks
  assert(
    result.summary.totalPolls === 1,
    `Expected 1 poll, got ${result.summary.totalPolls}`,
  );
  assert(result.summary.livePolls === 1, "Expected 1 live poll");
  assert(
    result.summary.totalVotes === 3,
    `Expected 3 votes, got ${result.summary.totalVotes}`,
  );
  assert(
    result.summary.totalContributions === 0,
    "Expected 0 contributions",
  );
  assert(
    result.summary.averageVotesPerPoll === 3,
    `Expected avg 3, got ${result.summary.averageVotesPerPoll}`,
  );
  console.log("  PASS: Summary metrics correct");

  // ═════════════════════════════════════════════════════════════════
  // Test 2: Per-poll breakdown
  // ═════════════════════════════════════════════════════════════════
  console.log("─── Test 2: Per-poll metrics ───");
  assert(
    result.polls.length === 1,
    `Expected 1 poll in array, got ${result.polls.length}`,
  );
  const pollData = result.polls[0];
  assert(pollData.id === pollAId, "Poll ID mismatch");
  assert(pollData.totalVotes === 3, "Poll votes mismatch");
  assert(pollData.options.length === 3, "Expected 3 options");
  assert(pollData.options[0].voteCount === 2, "Option 1 vote count wrong");
  assert(pollData.options[1].voteCount === 1, "Option 2 vote count wrong");
  assert(pollData.options[2].voteCount === 0, "Option 3 vote count wrong");
  console.log("  PASS: Per-poll metrics correct");

  // ═════════════════════════════════════════════════════════════════
  // Test 3: Activity feed
  // ═════════════════════════════════════════════════════════════════
  console.log("─── Test 3: Activity feed ───");
  assert(
    result.activity.length >= 4,
    `Expected >=4 activity items, got ${result.activity.length}`,
  );
  const voteActivity = result.activity.filter(
    (a: any) => a.type === "vote_received",
  );
  assert(
    voteActivity.length === 3,
    `Expected 3 vote activities, got ${voteActivity.length}`,
  );
  const pubActivity = result.activity.filter(
    (a: any) => a.type === "poll_published",
  );
  assert(pubActivity.length === 1, "Expected 1 publish activity");
  console.log("  PASS: Activity feed correct");

  // ═════════════════════════════════════════════════════════════════
  // Test 4: Creator B isolation
  // ═════════════════════════════════════════════════════════════════
  console.log("─── Test 4: Creator B isolation ───");
  const { data: intelB } = (await admin.rpc("get_creator_intelligence", {
    _creator_wallet: creatorB,
  } as any)) as any;
  const resultB = intelB as any;
  assert(
    resultB.summary.totalPolls === 1,
    "Creator B should have 1 poll",
  );
  assert(resultB.polls[0].id === pollBId, "Creator B poll ID should match");
  // Creator B must NOT see Creator A data
  assert(
    !JSON.stringify(resultB).includes(pollAId),
    "Creator B should NOT see Creator A poll",
  );
  console.log("  PASS: Creator isolation works");

  // ═════════════════════════════════════════════════════════════════
  // Test 5: Privacy — no voter wallet addresses in output
  // ═════════════════════════════════════════════════════════════════
  console.log("─── Test 5: Privacy ───");
  const json = JSON.stringify(result);
  assert(!json.includes("voter1"), "Voter wallet leaked");
  assert(!json.includes("voter2"), "Voter wallet leaked");
  assert(!json.includes("voter3"), "Voter wallet leaked");
  console.log("  PASS: No wallet addresses in output");

  // ═════════════════════════════════════════════════════════════════
  // Test 6: Public client DENIED
  // ═════════════════════════════════════════════════════════════════
  console.log("─── Test 6: Public DENIED ───");
  const { error: pubErr } = (await pubClient.rpc(
    "get_creator_intelligence",
    { _creator_wallet: creatorA } as any,
  )) as any;
  assert(pubErr !== null, "Public should be denied");
  console.log("  PASS: Public execution denied");

  // ═════════════════════════════════════════════════════════════════
  // Cleanup
  // ═════════════════════════════════════════════════════════════════
  try {
    for (const pid of [pollAId, pollBId]) {
      await admin.from("poll_votes").delete().eq("poll_id", pid);
      await admin.from("poll_options").delete().eq("poll_id", pid);
      await admin
        .from("poll_publication_requests")
        .delete()
        .eq("poll_id", pid);
      await admin.from("polls").delete().eq("id", pid);
    }
  } catch {
    // best-effort cleanup
  }

  console.log("\n═══ All intelligence tests passed ═══");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
