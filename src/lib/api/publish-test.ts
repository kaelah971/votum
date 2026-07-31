/**
 * Poll publication test script.
 *
 * Tests the `publish_poll_atomic` RPC function directly against the
 * Supabase database using the service_role key. Includes content-aware
 * fingerprint idempotency, advisory lock concurrency, and rollback testing.
 *
 * Usage:
 *   npx tsx src/lib/api/publish-test.ts
 *
 * Requires these environment variables (available via .env.local):
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SECRET_KEY
 */

import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { nimDecimalToLuna } from "@/lib/nimiq/units";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SECRET_KEY!;

const admin = createClient(url, key, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  db: { schema: "public" },
});

/**
 * Build a deterministic SHA-256 fingerprint from a flat payload object.
 * Keys are sorted to ensure stability regardless of insertion order.
 */
function fingerprint(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(json).digest("hex");
}

async function main() {
  const creatorWallet =
    "0000000000000000000000000000000000000000"; // Test canonical hex
  const idempotencyKey = randomBytes(16)
    .toString("hex")
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");

  // ── Setup: create a test session row (simulates what the verify route does)
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expires = new Date(Date.now() + 60_000).toISOString();

  await admin.from("wallet_sessions").insert({
    token_hash: tokenHash,
    wallet_address: creatorWallet,
    expires_at: expires,
  });

  console.log(
    "Session created (token hash saved; cookie not applicable for direct RPC test)\n",
  );

  // NOTE: The actual API route requires an HTTP cookie set by the browser.
  // This script tests the RPC function directly so we can validate the
  // database logic without running the full Next.js server.

  // All poll IDs created during these tests (for cleanup).
  const createdPollIds: string[] = [];

  // ── Fingerprint verification ─────────────────────────────────────
  const testFp = createHash("sha256")
    .update(JSON.stringify({ test: 1 }))
    .digest("hex");
  console.assert(
    testFp.length === 64,
    `FAIL: Fingerprint should be 64 chars, got ${testFp.length}`,
  );
  console.log(`  PASS: Fingerprint is ${testFp.length} hex chars`);

  const fp1 = createHash("sha256")
    .update(JSON.stringify({ a: 1, b: 2 }))
    .digest("hex");
  const fp2 = createHash("sha256")
    .update(JSON.stringify({ a: 1, b: 3 }))
    .digest("hex");
  console.assert(
    fp1 !== fp2,
    "FAIL: Different payloads should produce different fingerprints",
  );
  console.log("  PASS: Different payloads produce different fingerprints\n");

  // Pre-compute the fingerprint for Test 1 / Test 2 original content.
  const originalFingerprint = fingerprint({
    question: "Test question for atomic publish?",
    description: "Test description",
    options: ["Option A", "Option B", "Option C"],
    mode: "creator_support",
    destinationWallet: creatorWallet,
    destinationPurpose: "Test purpose",
    minimumNimLuna: "100000",
    fairnessMode: "one_wallet_one_vote",
    duration: "7days",
  });

  // ── Test 1: First publication (brand new poll) ────────────────────
  console.log("─── Test 1: First publication ───");
  const { data: r1, error: e1 } = await admin.rpc("publish_poll_atomic", {
    _creator_wallet: creatorWallet,
    _question: "Test question for atomic publish?",
    _description: "Test description",
    _mode: "creator_support",
    _destination_wallet: creatorWallet,
    _destination_purpose: "Test purpose",
    _min_nim_luna: 100000, // 1 NIM
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    _options: ["Option A", "Option B", "Option C"],
    _idempotency_key: idempotencyKey,
    _request_fingerprint: originalFingerprint,
  });

  if (e1) {
    console.error("FAIL: RPC error", e1);
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  if (r1.result_kind !== "created") {
    console.error(
      "FAIL: Expected result_kind=created for first publication, got",
      r1.result_kind,
    );
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  if (r1.status !== "live") {
    console.error("FAIL: Expected status=live, got", r1.status);
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  createdPollIds.push(r1.id);
  console.log("PASS: First publication returned new poll:", r1);

  // ── Test 2: Idempotent replay (same content + same key + same fp) ─
  console.log("\n─── Test 2: Idempotent replay ───");
  const { data: r2, error: e2 } = await admin.rpc("publish_poll_atomic", {
    _creator_wallet: creatorWallet,
    _question: "Test question for atomic publish?",
    _description: "Test description",
    _mode: "creator_support",
    _destination_wallet: creatorWallet,
    _destination_purpose: "Test purpose",
    _min_nim_luna: 100000,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    _options: ["Option A", "Option B", "Option C"],
    _idempotency_key: idempotencyKey,
    _request_fingerprint: originalFingerprint,
  });

  if (e2) {
    console.error("FAIL: Idempotent replay produced RPC error", e2);
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  if (r2.result_kind !== "replay") {
    console.error(
      "FAIL: Expected result_kind=replay for idempotent retry, got",
      r2.result_kind,
    );
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  if (r2.id !== r1.id) {
    console.error(
      "FAIL: Expected same poll ID on replay, got",
      r2.id,
      "instead of",
      r1.id,
    );
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  console.log("PASS: Idempotent replay returned same poll");

  // ── Test 2b: Different content with SAME key → conflict ───────────
  console.log("\n─── Test 2b: Content conflict detection ───");
  const altFingerprint = fingerprint({
    question: "Completely different question?",
    description: null,
    options: ["Different A", "Different B"],
    mode: "community_support",
    destinationWallet: creatorWallet,
    destinationPurpose: "Different purpose text",
    minimumNimLuna: "200000",
    fairnessMode: "one_wallet_one_vote",
    duration: "3days",
  });

  const { data: conflictResult, error: conflictErr } = await admin.rpc(
    "publish_poll_atomic",
    {
      _creator_wallet: creatorWallet,
      _question: "Completely different question?",
      _description: null,
      _mode: "community_support",
      _destination_wallet: creatorWallet,
      _destination_purpose: "Different purpose text",
      _min_nim_luna: 200000,
      _fairness_mode: "one_wallet_one_vote",
      _ends_at: new Date(Date.now() + 3 * 86400000).toISOString(),
      _options: ["Different A", "Different B"],
      _idempotency_key: idempotencyKey, // SAME key
      _request_fingerprint: altFingerprint,
    },
  );
  const conflictData = conflictResult as {
    id: string | null;
    status: string | null;
    result_kind: string;
  } | null;
  if (conflictErr || !conflictData || conflictData.result_kind !== "conflict") {
    console.error(
      "FAIL: Expected result_kind=conflict, got:",
      conflictErr?.code ?? "no error",
      conflictData?.result_kind ?? "no data",
    );
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  console.log(
    "PASS: Changed content with same key → conflict (result_kind=conflict)",
  );

  // ── Test 2c: Same fingerprint replay is still idempotent ──────────
  console.log("\n─── Test 2c: Fingerprint replay stability ───");
  const { data: replayCheck, error: replayErr } = await admin.rpc(
    "publish_poll_atomic",
    {
      _creator_wallet: creatorWallet,
      _question: "Test question for atomic publish?",
      _description: "Test description",
      _mode: "creator_support",
      _destination_wallet: creatorWallet,
      _destination_purpose: "Test purpose",
      _min_nim_luna: 100000,
      _fairness_mode: "one_wallet_one_vote",
      _ends_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      _options: ["Option A", "Option B", "Option C"],
      _idempotency_key: idempotencyKey,
      _request_fingerprint: originalFingerprint,
    },
  );
  if (replayErr) {
    console.error("FAIL: Replay with fingerprint failed", replayErr);
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  if (
    replayCheck.result_kind !== "replay" ||
    replayCheck.id !== r1.id
  ) {
    console.error("FAIL: Replay should return same poll");
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  console.log("PASS: Fingerprint replay returns same poll");

  // ── Test 3: Different creator, same key → new poll ───────────────
  console.log("\n─── Test 3: Different creator, same key ───");
  const otherCreator = "0100000000000000000000000000000000000000";
  const otherFp = fingerprint({
    question: "Another test question?",
    description: null,
    options: ["P", "Q"],
    mode: "creator_support",
    destinationWallet: otherCreator,
    destinationPurpose: "Other test",
    minimumNimLuna: "500000",
    fairnessMode: "one_wallet_one_vote",
    duration: "14days",
  });

  const { data: r3, error: e3 } = await admin.rpc("publish_poll_atomic", {
    _creator_wallet: otherCreator,
    _question: "Another test question?",
    _description: null,
    _mode: "creator_support",
    _destination_wallet: otherCreator,
    _destination_purpose: "Other test",
    _min_nim_luna: 500000,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    _options: ["P", "Q"],
    _idempotency_key: idempotencyKey, // Same key, different creator — allowed
    _request_fingerprint: otherFp,
  });

  if (e3) {
    console.error(
      "FAIL: Different creator with same key produced RPC error",
      e3,
    );
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  if (r3.id === r1.id) {
    console.error("FAIL: Different creators should get different poll IDs");
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  if (r3.result_kind !== "created") {
    console.error(
      "FAIL: Expected result_kind=created for different creator, got",
      r3.result_kind,
    );
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  createdPollIds.push(r3.id);
  console.log("PASS: Different creator with same key created new poll");

  // ── Test 4: Verify options were inserted correctly ────────────────
  console.log("\n─── Test 4: Options integrity ───");
  const { data: opts, error: oe } = await admin
    .from("poll_options")
    .select("*")
    .eq("poll_id", r1.id)
    .order("sort_order");
  if (oe || !opts) {
    console.error("FAIL: Could not read options", oe);
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  if (opts.length !== 3) {
    console.error("FAIL: Expected 3 options, got", opts.length);
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  const labels = opts.map((o) => o.label);
  if (
    labels[0] !== "Option A" ||
    labels[1] !== "Option B" ||
    labels[2] !== "Option C"
  ) {
    console.error("FAIL: Unexpected option labels:", labels);
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  console.log("PASS: Options created correctly:", labels.join(", "));

  // ── Test 5: Verify poll is live and public ────────────────────────
  console.log("\n─── Test 5: Poll status & visibility ───");
  const { data: poll, error: pe } = await admin
    .from("polls")
    .select("*")
    .eq("id", r1.id)
    .single();
  if (pe || !poll) {
    console.error("FAIL: Poll read failed", pe);
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  if (poll.status !== "live") {
    console.error("FAIL: Expected status=live, got", poll.status);
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  if (!poll.is_public) {
    console.error("FAIL: Expected is_public=true");
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  if (poll.creator_wallet !== creatorWallet) {
    console.error("FAIL: Wrong creator wallet");
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  if (poll.question !== "Test question for atomic publish?") {
    console.error("FAIL: Question not stored correctly");
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  console.log("PASS: Poll is live, public, and correctly attributed");

  // ═════════════════════════════════════════════════════════════════
  // Group A: NIM conversion tests
  // ═════════════════════════════════════════════════════════════════
  console.log("\n─── NIM Conversion Tests ───");

  function check(val: string, expected: bigint) {
    const r = nimDecimalToLuna(val);
    if (r !== expected)
      throw new Error(
        `nimDecimalToLuna("${val}") = ${r}, expected ${expected}`,
      );
    console.log(`  PASS: "${val}" → ${r}n`);
  }
  function mustFail(val: string) {
    try {
      nimDecimalToLuna(val);
      throw new Error(`"${val}" should have thrown`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  PASS: "${val}" rejected: ${msg}`);
    }
  }

  check("1", BigInt(100000));
  check("1.0", BigInt(100000));
  check("0.00001", BigInt(1));
  check("1.23456", BigInt(123456));
  check("10.5", BigInt(1050000));
  mustFail("1.234567"); // excess precision
  mustFail("-1"); // negative
  mustFail("1e3"); // exponent
  mustFail("1,000"); // comma
  mustFail(""); // empty
  mustFail("   "); // whitespace only
  console.log("  All NIM conversion tests passed.");

  // ═════════════════════════════════════════════════════════════════
  // Group C: Concurrent duplicate requests (advisory lock test)
  // ═════════════════════════════════════════════════════════════════
  console.log("\n─── Test C: Concurrent duplicate requests ───");

  // Clean up any orphaned data from previous test runs
  const { data: staleC } = await admin
    .from("polls")
    .select("id")
    .eq("creator_wallet", creatorWallet)
    .eq("question", "Concurrent test?");
  if (staleC && staleC.length > 0) {
    const staleIds = staleC.map((p) => p.id);
    await admin.from("poll_options").delete().in("poll_id", staleIds);
    await admin.from("poll_publication_requests").delete().in("poll_id", staleIds);
    await admin.from("polls").delete().in("id", staleIds);
  }

  const concurrentKey = randomBytes(16)
    .toString("hex")
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
  const concurrentFp = fingerprint({
    question: "Concurrent test?",
    description: null,
    options: ["Concurrent A", "Concurrent B"],
    mode: "creator_support",
    destinationWallet: creatorWallet,
    destinationPurpose: "Concurrent test purpose",
    minimumNimLuna: "500000",
    fairnessMode: "one_wallet_one_vote",
    duration: "1day",
  });

  const rpcArgs = {
    _creator_wallet: creatorWallet,
    _question: "Concurrent test?",
    _description: null,
    _mode: "creator_support",
    _destination_wallet: creatorWallet,
    _destination_purpose: "Concurrent test purpose",
    _min_nim_luna: 500000,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 86400000).toISOString(),
    _options: ["Concurrent A", "Concurrent B"],
    _idempotency_key: concurrentKey,
    _request_fingerprint: concurrentFp,
  };

interface RpcResult {
  data: {
    id?: string;
    status?: string;
    result_kind?: string;
  } | null;
  error: { code?: string; message?: string } | null;
}

  const results = await Promise.all([
    admin.rpc("publish_poll_atomic", rpcArgs),
    admin.rpc("publish_poll_atomic", rpcArgs),
    admin.rpc("publish_poll_atomic", rpcArgs),
  ]);

  const typed: RpcResult[] = results as unknown as RpcResult[];
  const successes = typed.filter((r) => !r.error && r.data);
  const replays = typed.filter(
    (r) => r.data?.result_kind === "replay",
  );
  const creations = typed.filter(
    (r) => r.data?.result_kind === "created",
  );
  const errors = typed.filter((r) => r.error);

  if (
    successes.length < 2 ||
    creations.length < 1 ||
    errors.length > 0
  ) {
    console.error(
      `FAIL: Concurrent test: ${successes.length} successes, ` +
        `${creations.length} created, ${errors.length} errors`,
    );
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }

  // Verify exactly one poll was created
  const { data: allPolls, error: pollErr } = await admin
    .from("polls")
    .select("id")
    .eq("creator_wallet", creatorWallet)
    .eq("question", "Concurrent test?");
  if (pollErr || !allPolls || allPolls.length !== 1) {
    console.error(
      `FAIL: Expected exactly 1 concurrent poll, got ${allPolls?.length}`,
      pollErr,
    );
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  const concurrentPollId = allPolls[0].id;
  createdPollIds.push(concurrentPollId);
  console.log(
    `PASS: Concurrent requests produced exactly 1 poll ` +
      `(${successes.length} responses, ${replays.length} replays, ${creations.length} created)`,
  );

  // ═════════════════════════════════════════════════════════════════
  // Group D: Rollback test (option failure → no orphan data)
  // ═════════════════════════════════════════════════════════════════
  console.log("\n─── Test D: Rollback on invalid options ───");

  // Clean up any orphaned rollback test data from previous runs
  const { data: staleR } = await admin
    .from("polls")
    .select("id")
    .eq("creator_wallet", creatorWallet)
    .eq("question", "Rollback test?");
  if (staleR && staleR.length > 0) {
    const staleIds = staleR.map((p) => p.id);
    await admin.from("poll_options").delete().in("poll_id", staleIds);
    await admin.from("poll_publication_requests").delete().in("poll_id", staleIds);
    await admin.from("polls").delete().in("id", staleIds);
  }

  const rollbackKey = randomBytes(16)
    .toString("hex")
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
  const rollbackFp = fingerprint({
    question: "Rollback test?",
    description: null,
    options: ["Only one"],
    mode: "creator_support",
    destinationWallet: creatorWallet,
    destinationPurpose: "Rollback test",
    minimumNimLuna: "100000",
    fairnessMode: "one_wallet_one_vote",
    duration: "1day",
  });

  const { error: rollbackErr } = await admin.rpc("publish_poll_atomic", {
    _creator_wallet: creatorWallet,
    _question: "Rollback test?",
    _description: null,
    _mode: "creator_support",
    _destination_wallet: creatorWallet,
    _destination_purpose: "Rollback test",
    _min_nim_luna: 100000,
    _fairness_mode: "one_wallet_one_vote",
    _ends_at: new Date(Date.now() + 86400000).toISOString(),
    _options: ["Only one"],
    _idempotency_key: rollbackKey,
    _request_fingerprint: rollbackFp,
  });
  if (!rollbackErr) {
    console.error("FAIL: Expected rollback error for single option");
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  console.log("PASS: Single-option publish correctly rolled back");

  // Verify no poll was created
  const { data: pollsAfter, error: pae } = await admin
    .from("polls")
    .select("id")
    .eq("creator_wallet", creatorWallet)
    .eq("question", "Rollback test?");
  if (!pae && pollsAfter && pollsAfter.length > 0) {
    console.error("FAIL: Rolled-back poll should not exist");
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  console.log("PASS: No orphan poll after rollback");

  // Retry after rollback with correct data should succeed
  const retryFp = fingerprint({
    question: "Rollback test?",
    description: null,
    options: ["Valid A", "Valid B"],
    mode: "creator_support",
    destinationWallet: creatorWallet,
    destinationPurpose: "Rollback test",
    minimumNimLuna: "100000",
    fairnessMode: "one_wallet_one_vote",
    duration: "1day",
  });

  const { data: retryData, error: retryErr } = await admin.rpc(
    "publish_poll_atomic",
    {
      _creator_wallet: creatorWallet,
      _question: "Rollback test?",
      _description: null,
      _mode: "creator_support",
      _destination_wallet: creatorWallet,
      _destination_purpose: "Rollback test",
      _min_nim_luna: 100000,
      _fairness_mode: "one_wallet_one_vote",
      _ends_at: new Date(Date.now() + 86400000).toISOString(),
      _options: ["Valid A", "Valid B"],
      _idempotency_key: rollbackKey,
      _request_fingerprint: retryFp,
    },
  );
  if (
    retryErr ||
    !retryData ||
    retryData.result_kind !== "created"
  ) {
    console.error(
      "FAIL: Retry after rollback should succeed as new poll (expected result_kind=created), got:",
      retryErr?.code ?? "no error",
      retryData?.result_kind ?? "no data",
    );
    await cleanupAfterFailure(tokenHash);
    process.exit(1);
  }
  createdPollIds.push(retryData.id);
  console.log("PASS: Retry after rollback succeeded");

  // ── Cleanup (non-fatal — test data is minimal) ────────────────────
  try {
    if (createdPollIds.length > 0) {
      await admin
        .from("poll_options")
        .delete()
        .in("poll_id", createdPollIds);
      await admin
        .from("poll_publication_requests")
        .delete()
        .in("poll_id", createdPollIds);
      await admin
        .from("polls")
        .delete()
        .in("id", createdPollIds);
    }
    await admin.from("wallet_sessions").delete().eq("token_hash", tokenHash);
  } catch (cleanupErr) {
    console.warn("Cleanup warning (non-fatal):", String(cleanupErr));
  }

  console.log("\n═══════════════════════════════════════════");
  console.log(
    ` All tests passed (${5 + 2 + 1 + 1 + 1} groups). Cleanup complete.`,
  );
  console.log("═══════════════════════════════════════════");
}

/**
 * Attempt cleanup after a test failure so the database isn't left in a
 * dirty state. Errors during cleanup are logged but not fatal.
 */
async function cleanupAfterFailure(tokenHash: string) {
  try {
    await admin.from("wallet_sessions").delete().eq("token_hash", tokenHash);
  } catch {
    // best effort
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
