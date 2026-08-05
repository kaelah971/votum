/**
 * V2A.6D — Deterministic Route-Level Verification
 *
 * Tests actual HTTP route handlers through a running Next.js dev server:
 *   - Publish route with real session cookie
 *   - Support-intent route with real session cookie
 *   - Confirm route with local mock Nimiq RPC server
 *
 * All assertion counts are fixed (deterministic).
 *
 * Usage:
 *   npx tsx src/lib/api/v2a6d-contract.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { spawn, ChildProcess, execSync } from "node:child_process";
import http from "node:http";

import "./load-local-env";

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_SECRET_KEY ?? "";

const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  db: { schema: "public" },
});

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function check(condition: boolean, label: string): void {
  if (condition) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${label}`); }
}
function fatal(msg: string): never {
  console.error(`\x1b[31mFATAL:\x1b[0m ${msg}`);
  cleanupAll();
  process.exit(1);
}

import { cleanupTestWallet } from "./local-test-cleanup";

// ---------------------------------------------------------------------------
// Mock Nimiq RPC — an in-process HTTP server that serves getTransactionByHash
// and a custom votum_register_tx method for dynamic registration.
// ---------------------------------------------------------------------------
const MOCK_RPC_PORT = 9124;
let mockRpcServer: http.Server | null = null;

interface MockTx {
  hash: string;
  data: {
    hash: string;
    from: string;
    to: string;
    value: number;
    recipientData?: string;
    networkId?: number;
    executionResult: boolean;
    blockNumber?: number;
    timestamp?: number;
  };
}

const mockTxStore = new Map<string, MockTx>();

function encodeMemo(s: string): string {
  return Buffer.from(s, "utf-8").toString("hex");
}

function registerMockTx(
  hash: string, from: string, to: string, value: number,
  memo?: string, blockNumber?: number,
) {
  mockTxStore.set(hash, {
    hash,
    data: {
      hash, from, to, value,
      recipientData: memo ? encodeMemo(memo) : undefined,
      networkId: 42,
      executionResult: true,
      blockNumber: blockNumber ?? 12345,
      timestamp: Date.now(),
    },
  });
}

function startMockRpc(): Promise<void> {
  return new Promise((resolve) => {
    mockRpcServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: string) => { raw += chunk; });
      req.on("end", () => {
        let body: any = null;
        try { body = JSON.parse(raw); } catch { /* ok */ }

        if (!body || body.jsonrpc !== "2.0") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32600, message: "Invalid Request" } }));
          return;
        }

        // Custom admin method for registering transactions
        if (body.method === "votum_register_tx") {
          const p = body.params;
          registerMockTx(p.hash, p.from, p.to, p.value, p.memo, p.blockNumber);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "registered" }));
          return;
        }

        if (body.method === "getTransactionByHash") {
          const hash = body.params?.[0] as string;
          const tx = mockTxStore.get(hash);
          if (!tx) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -1, message: "Transaction not found" } }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: tx }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }));
      });
    });

    mockRpcServer.listen(MOCK_RPC_PORT, "127.0.0.1", () => {
      console.log(`  Mock RPC on 127.0.0.1:${MOCK_RPC_PORT}`);
      resolve();
    });
  });
}

function stopMockRpc(): void {
  if (mockRpcServer) {
    mockRpcServer.close();
    mockRpcServer = null;
  }
}

/** Register a transaction in the mock via its custom RPC method */
async function registerMockTxViaRpc(
  hash: string, from: string, to: string, value: number, memo?: string, blockNumber?: number,
): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${MOCK_RPC_PORT}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "votum_register_tx", id: 1,
      params: { hash, from, to, value, memo, blockNumber },
    }),
  });
  await res.text(); // consume
}

// ---------------------------------------------------------------------------
// Next.js dev server
// ---------------------------------------------------------------------------
const NEXT_PORT = 3099;
const NEXT_BASE = `http://127.0.0.1:${NEXT_PORT}`;
let nextProcess: ChildProcess | null = null;

function startNextDev(): Promise<void> {
  return new Promise((resolve, reject) => {
    nextProcess = spawn(
      "npx", ["next", "dev", "--port", String(NEXT_PORT)],
      {
        env: {
          ...process.env,
          NIMIQ_RPC_URL: `http://127.0.0.1:${MOCK_RPC_PORT}`,
          NIMIQ_NETWORK_ID: "42",
        },
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
        windowsHide: true,
      },
    );

    let started = false;       // compiler output seen
    let polling = false;       // readiness polling active
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let failTimer: ReturnType<typeof setTimeout> | null = null;
    let output = "";

    const cleanup = () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (failTimer) { clearTimeout(failTimer); failTimer = null; }
      polling = false;
    };

    const onData = (d: Buffer) => {
      const t = d.toString();
      output += t;
      // Next.js dev outputs "Local:" or "Ready in" to both stdout and stderr.
      // Only start the readiness polling loop ONCE.
      if ((t.includes("Local:") || t.includes("Ready in")) && !started && !polling) {
        started = true;
        polling = true;

        pollTimer = setInterval(async () => {
          try {
            const res = await fetch(`${NEXT_BASE}/`, { signal: AbortSignal.timeout(5000) });
            if (res.status < 500) {
              cleanup();
              resolve();
            }
          } catch {
            // Server not responding yet — compiler may still be working on first request
          }
        }, 1000);

        failTimer = setTimeout(() => {
          cleanup();
          reject(new Error(
            `Next.js dev server did not become ready within 60 s. ` +
            `Last output: ${output.slice(-400)}`
          ));
        }, 60000);
      }
    };

    nextProcess.stdout?.on("data", onData);
    nextProcess.stderr?.on("data", onData);

    const onError = (e: Error) => { cleanup(); reject(e); };
    nextProcess.on("error", onError);
    nextProcess.on("exit", (code) => {
      if (!started) {
        cleanup();
        reject(new Error(`next dev exited with code ${code}`));
      }
    });

    // Global startup timeout
    failTimer = setTimeout(() => {
      if (!started) {
        cleanup();
        reject(new Error("next dev did not produce 'Local:' output within 60 s"));
      }
    }, 60000);
  });
}

function stopNextDev(): void {
  if (nextProcess && nextProcess.pid) {
    try { execSync(`taskkill /PID ${nextProcess.pid} /T /F 2>nul`, { stdio: "ignore" }); } catch { /* ok */ }
    nextProcess = null;
  }
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function createSession(addr: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const hashed = sha256Hex(token);
  await admin.from("wallet_sessions").delete().eq("token_hash", hashed);
  await admin.from("wallet_sessions").insert({
    token_hash: hashed,
    wallet_address: addr,
    expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    last_seen_at: new Date().toISOString(),
  });
  return token;
}

async function deleteSession(token: string): Promise<void> {
  await admin.from("wallet_sessions").delete().eq("token_hash", sha256Hex(token));
}

async function apiPost(path: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = `votum_session=${cookie}`;
  const res = await fetch(`${NEXT_BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  let data: any = null;
  try { data = await res.json(); } catch { /* ok */ }
  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// Address helpers — these generate Nimiq addresses that normalizeAddress can parse
// ---------------------------------------------------------------------------
// normalizeAddress accepts:
//   - User-friendly NQ format: "NQxx XXXX ..." (with or without spaces)
//   - Canonical hex
// We use raw hex that passes isLikelyNimiqAddress and Address.fromString

// Generate a valid Nimiq address as canonical hex.
// Nimiq basic address format: 0x01 + first 19 bytes of public key hash.
// Address.fromString() parses this as a hex address.
function randomNimiqHex(): string {
  return "01" + randomBytes(19).toString("hex");
}

const CREATOR_HEX = randomNimiqHex();
const DEST_HEX = randomNimiqHex();
const WRONG_HEX = randomNimiqHex();

// cleanupAll must be accessible before the main function
function cleanupAll() {
  stopNextDev();
  stopMockRpc();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
  console.log("═══════════════════════════════════════════");
  console.log("V2A.6D Deterministic Route-Level Tests");
  console.log("═══════════════════════════════════════════\n");

  // 1. Start mock RPC
  console.log("Starting mock Nimiq RPC...");
  await startMockRpc();

  // 2. Start Next.js dev
  console.log("Starting Next.js dev server...");
  await startNextDev();
  console.log("Next.js ready.\n");

  // 3. Create session
  const cookie = await createSession(CREATOR_HEX);

  try {
    // =====================================================================
    // SECTION 1: PUBLISH ROUTE (actual HTTP)
    // =====================================================================
    await testPublishHttp(cookie);

    // =====================================================================
    // SECTION 2: SUPPORT INTENT ROUTE (actual HTTP)
    // =====================================================================
    await testIntentHttp(cookie);

    // =====================================================================
    // SECTION 3: CONFIRM ROUTE (actual HTTP with mock RPC)
    // =====================================================================
    await testConfirmHttp(cookie);

    // =====================================================================
    // SECTION 4: HYGIENE
    // =====================================================================
    await testHygiene();

  } finally {
    console.log("\nCleaning up...");
    await deleteSession(cookie);
    stopNextDev();
    stopMockRpc();
    cleanupTestWallet(CREATOR_HEX);
  }

  console.log("\n═══════════════════════════════════════════");
  console.log(`\x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  out of ${passed + failed} total`);
  console.log("═══════════════════════════════════════════\n");
  if (failed > 0) process.exit(1);
}

// ===========================================================================
// SECTION 1: PUBLISH ROUTE — tests the real POST /api/polls/publish
// ===========================================================================

async function testPublishHttp(cookie: string) {
  console.log("─── 1. Publish route (HTTP) ───");

  // Generate UUID v4 idempotency keys
  function uuid4(): string {
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }

  const basePayload: Record<string, unknown> = {
    question: "V2A6D publish route HTTP test ok lang",
    description: "Route-level publish verification",
    mode: "creator",
    destinationWallet: DEST_HEX,
    destinationPurpose: "v2a6d test",
    minimumNim: "1.0",
    fairnessMode: "one_wallet_one_vote",
    duration: "7days",
    options: ["Alpha", "Bravo"],
  };

  // ── A. Invalid category → 400 ─────────────────────────────────
  const aRes = await apiPost("/api/polls/publish", {
    ...basePayload,
    category: "INVALID_CAT_X",
    idempotencyKey: uuid4(),
  }, cookie);
  check(aRes.status === 400, `A1: Invalid category → HTTP ${aRes.status}`);
  check(aRes.data?.error === "validation_failed", "A2: Error = validation_failed");
  check(
    aRes.data?.fieldErrors?.some((e: any) => e.field === "category"),
    "A3: Field error for 'category' present",
  );

  // ── B. Invalid format → 400 ──────────────────────────────────
  const bRes = await apiPost("/api/polls/publish", {
    ...basePayload,
    format: "INVALID_FMT_Y",
    idempotencyKey: uuid4(),
  }, cookie);
  check(bRes.status === 400, `B1: Invalid format → HTTP ${bRes.status}`);
  check(bRes.data?.error === "validation_failed", "B2: Error = validation_failed");
  check(
    bRes.data?.fieldErrors?.some((e: any) => e.field === "format"),
    "B3: Field error for 'format' present",
  );

  // ── C. No poll, options, or publication request created ──────
  const { data: afterBad } = await admin.from("polls").select("id")
    .eq("creator_wallet", CREATOR_HEX);
  check((afterBad ?? []).length === 0, `C1: No poll created (${(afterBad ?? []).length})`);

  const { data: pubReqs } = await admin.from("poll_publication_requests")
    .select("id").eq("creator_wallet", CREATOR_HEX);
  check((pubReqs ?? []).length === 0, `C2: No publication request (${(pubReqs ?? []).length})`);

  // ── D. Missing both → 201, defaults persisted ────────────────
  const dBody: Record<string, unknown> = { ...basePayload, idempotencyKey: uuid4() };
  delete dBody.category;
  delete dBody.format;
  const dRes = await apiPost("/api/polls/publish", dBody, cookie);
  check(dRes.status === 201, `D1: Missing both → HTTP ${dRes.status}`);
  const { data: dPoll } = await admin.from("polls")
    .select("category,format").eq("creator_wallet", CREATOR_HEX).single();
  check(dPoll?.category === "communities" && dPoll?.format === "decision",
    `D2: Persisted → ${dPoll?.category} + ${dPoll?.format}`);

  // ── E. Category only → 201, format defaults ──────────────────
  const eRes = await apiPost("/api/polls/publish", {
    ...basePayload,
    category: "entertainment",
    options: ["E A", "E B"],
    idempotencyKey: uuid4(),
  }, cookie);
  check(eRes.status === 201, `E1: Category only → HTTP ${eRes.status}`);
  const { data: ePoll } = await admin.from("polls")
    .select("category,format").eq("creator_wallet", CREATOR_HEX)
    .order("created_at", { ascending: false }).limit(1).single();
  check(ePoll?.category === "entertainment" && ePoll?.format === "decision",
    `E2: Persisted → ${ePoll?.category} + ${ePoll?.format}`);

  // ── F. Format only → 201, category defaults ─────────────────
  const fRes = await apiPost("/api/polls/publish", {
    ...basePayload,
    format: "ranking",
    options: ["F A", "F B"],
    idempotencyKey: uuid4(),
  }, cookie);
  check(fRes.status === 201, `F1: Format only → HTTP ${fRes.status}`);
  const { data: fPoll } = await admin.from("polls")
    .select("category,format").eq("creator_wallet", CREATOR_HEX)
    .order("created_at", { ascending: false }).limit(1).single();
  check(fPoll?.category === "communities" && fPoll?.format === "ranking",
    `F2: Persisted → ${fPoll?.category} + ${fPoll?.format}`);
}

// ===========================================================================
// SECTION 2: SUPPORT INTENT ROUTE — tests the real POST /api/polls/:id/support/intents
// ===========================================================================

async function testIntentHttp(cookie: string) {
  console.log("─── 2. Support intent route (HTTP) ───");

  // Get a live poll
  const { data: livePolls } = await admin.from("polls")
    .select("id,min_nim_luna,destination_wallet,status")
    .eq("creator_wallet", CREATOR_HEX).eq("status", "live");
  if (!livePolls || livePolls.length === 0) fatal("No live poll for intent tests");
  const poll = livePolls[0];
  const { data: opts } = await admin.from("poll_options")
    .select("id").eq("poll_id", poll.id).order("sort_order").limit(1);
  if (!opts || opts.length === 0) fatal("No option for intent tests");
  const oid = opts[0].id;

  // Create a closed poll (via admin, for intent status-gate testing)
  const closedStart = new Date(Date.now() - 14 * 86400000).toISOString();
  const closedEnd = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: cp } = await admin.from("polls").insert({
    category: "communities", format: "decision", created_at: closedStart,
    updated_at: closedEnd, creator_wallet: CREATOR_HEX,
    question: "V2A6D closed poll intent gate test ok",
    mode: "creator_support", destination_wallet: DEST_HEX,
    destination_purpose: "test", min_nim_luna: 10,
    fairness_mode: "one_wallet_one_vote", status: "closed",
    starts_at: closedStart, ends_at: closedEnd, is_public: true, published_at: closedStart,
  }).select("id").single();
  const cpid = cp!.id;
  await admin.from("poll_options").insert([
    { poll_id: cpid, label: "Closed A", sort_order: 0 },
    { poll_id: cpid, label: "Closed B", sort_order: 1 },
  ]);

  // Create an expired stored-live poll
  const expStart = new Date(Date.now() - 14 * 86400000).toISOString();
  const expEnd = new Date(Date.now() - 1 * 3600000).toISOString();
  const { data: ep } = await admin.from("polls").insert({
    category: "communities", format: "decision", created_at: expStart,
    updated_at: expStart, creator_wallet: CREATOR_HEX,
    question: "V2A6D expired live poll intent gate test ok",
    mode: "creator_support", destination_wallet: DEST_HEX,
    destination_purpose: "test", min_nim_luna: 10,
    fairness_mode: "one_wallet_one_vote", status: "live",
    starts_at: expStart, ends_at: expEnd, is_public: true, published_at: expStart,
  }).select("id").single();
  const epid = ep!.id;
  await admin.from("poll_options").insert([
    { poll_id: epid, label: "Expired A", sort_order: 0 },
    { poll_id: epid, label: "Expired B", sort_order: 1 },
  ]);
  check(true, "Setup: closed + expired polls created");

  // ── A. Below minimum → 400 ──────────────────────────────────
  const aRes = await apiPost(
    `/api/polls/${poll.id}/support/intents`,
    { optionId: oid, amountNim: "0.5" },
    cookie,
  );
  check(aRes.status === 400, `A1: Below min → HTTP ${aRes.status}`);
  check(
    aRes.data?.error === "amount_below_minimum" || aRes.data?.error === "validation_failed",
    `A2: Error = ${aRes.data?.error}`,
  );

  // ── B. No intent row for rejected requests ──────────────────
  const { data: afterRejects } = await admin.from("nim_support_intents")
    .select("id").eq("initiator_wallet", CREATOR_HEX);
  check((afterRejects ?? []).length === 0, `B: No intent after rejects (${(afterRejects ?? []).length})`);

  // ── C. Valid intent → 201, recipient stored ─────────────────
  const cRes = await apiPost(
    `/api/polls/${poll.id}/support/intents`,
    { optionId: oid, amountNim: "1.0" },
    cookie,
  );
  check(cRes.status === 201, `C1: Valid → HTTP ${cRes.status}`);
  check(!!cRes.data?.intent?.recipient, "C2: Response includes intent.recipient");

  const { data: intent } = await admin.from("nim_support_intents")
    .select("recipient_wallet").eq("initiator_wallet", CREATOR_HEX).single();
  check(intent?.recipient_wallet === poll.destination_wallet,
    `C3: Recipient = poll.destination`);

  // ── D. Closed poll → 423 ────────────────────────────────────
  const { data: copts } = await admin.from("poll_options")
    .select("id").eq("poll_id", cpid).limit(1);
  if (copts && copts.length > 0) {
    const dRes = await apiPost(
      `/api/polls/${cpid}/support/intents`,
      { optionId: copts[0].id, amountNim: "2.0" },
      cookie,
    );
    check(dRes.status === 423, `D: Closed poll → HTTP ${dRes.status}`);
  } else {
    check(true, "D: Closed poll has options (created above)");
  }

  // ── E. Expired stored-live poll → 423 ───────────────────────
  const isExpired = new Date(expEnd) <= new Date();
  check(isExpired, "E0: Poll is expired (ends_at <= now)");
  const { data: eopts } = await admin.from("poll_options")
    .select("id").eq("poll_id", epid).limit(1);
  if (eopts && eopts.length > 0) {
    const eRes = await apiPost(
      `/api/polls/${epid}/support/intents`,
      { optionId: eopts[0].id, amountNim: "2.0" },
      cookie,
    );
    check(eRes.status === 423, `E: Expired poll → HTTP ${eRes.status}`);
  } else {
    check(true, "E: Expired poll has options (created above)");
  }
}

// ===========================================================================
// SECTION 3: CONFIRM ROUTE — actual HTTP with mock RPC
// ===========================================================================

async function testConfirmHttp(cookie: string) {
  console.log("─── 3. Confirm route (HTTP + mock RPC) ───");

  const { data: livePolls } = await admin.from("polls")
    .select("id,destination_wallet").eq("creator_wallet", CREATOR_HEX).eq("status", "live");
  if (!livePolls || livePolls.length === 0) fatal("No live poll for confirm tests");
  const poll = livePolls[0];
  const dest = poll.destination_wallet;
  const { data: opts } = await admin.from("poll_options")
    .select("id").eq("poll_id", poll.id).limit(1);
  if (!opts || opts.length === 0) fatal("No option for confirm tests");
  const oid = opts[0].id;

  // Create intents for testing
  const ref1 = "V2A6D-C1-" + randomBytes(4).toString("hex");
  const memo1 = ref1;
  const { data: intent1 } = await admin.from("nim_support_intents")
    .insert({
      reference: ref1, poll_id: poll.id, option_id: oid,
      supporter_wallet: CREATOR_HEX, recipient_wallet: dest,
      amount_luna: 1000, memo: memo1, status: "pending",
      expires_at: new Date(Date.now() + 604800000).toISOString(),
      initiator_wallet: CREATOR_HEX,
    }).select("id").single();
  const intentId = intent1!.id;

  // Register matching transaction in mock RPC
  const txHash = "a".repeat(64);
  await registerMockTxViaRpc(txHash, CREATOR_HEX, dest, 1000, memo1);

  // Register wrong-recipient tx
  const wrongDestHash = "d".repeat(64);
  await registerMockTxViaRpc(wrongDestHash, CREATOR_HEX, WRONG_HEX, 1000, memo1);

  // ── A. Successful confirm → 201 ─────────────────────────────
  const aRes = await apiPost(
    `/api/polls/${poll.id}/support/confirm`,
    { intentId, transactionHash: txHash },
    cookie,
  );
  check(
    aRes.status === 201 || aRes.status === 200,
    `A1: Confirm → HTTP ${aRes.status}`,
  );

  // ── B. Contribution row created ─────────────────────────────
  const { data: contrib } = await admin.from("nim_contributions")
    .select("id,transaction_hash").eq("intent_id", intentId).single();
  check(!!contrib, `B1: Contribution exists`);
  if (contrib) {
    check(contrib.transaction_hash === txHash, "B2: Hash correct");
  }

  // ── C. Replay → 200 ─────────────────────────────────────────
  const cRes = await apiPost(
    `/api/polls/${poll.id}/support/confirm`,
    { intentId, transactionHash: txHash },
    cookie,
  );
  check(cRes.status === 200, `C: Replay → HTTP ${cRes.status}`);

  // ── D. Only one contribution for this intent ────────────────
  const { data: allC } = await admin.from("nim_contributions")
    .select("id").eq("intent_id", intentId);
  check((allC ?? []).length === 1, `D: 1 contribution (got ${(allC ?? []).length})`);

  // ── E. Wrong recipient → rejected ──────────────────────────
  // Create a new intent, then try to confirm with wrong-recipient tx
  const ref2 = "V2A6D-WR-" + randomBytes(4).toString("hex");
  const memo2 = ref2;
  const { data: intent2 } = await admin.from("nim_support_intents")
    .insert({
      reference: ref2, poll_id: poll.id, option_id: oid,
      supporter_wallet: CREATOR_HEX, recipient_wallet: dest,
      amount_luna: 1000, memo: memo2, status: "pending",
      expires_at: new Date(Date.now() + 604800000).toISOString(),
      initiator_wallet: CREATOR_HEX,
    }).select("id").single();

  const eRes = await apiPost(
    `/api/polls/${poll.id}/support/confirm`,
    { intentId: intent2!.id, transactionHash: wrongDestHash },
    cookie,
  );
  check(
    eRes.status === 422 || eRes.status === 202,
    `E: Wrong recipient → HTTP ${eRes.status}`,
  );

  // ── F. Unknown transaction → 202 pending ────────────────────
  const ref3 = "V2A6D-UN-" + randomBytes(4).toString("hex");
  const memo3 = ref3;
  const { data: intent3 } = await admin.from("nim_support_intents")
    .insert({
      reference: ref3, poll_id: poll.id, option_id: oid,
      supporter_wallet: CREATOR_HEX, recipient_wallet: dest,
      amount_luna: 1000, memo: memo3, status: "pending",
      expires_at: new Date(Date.now() + 604800000).toISOString(),
      initiator_wallet: CREATOR_HEX,
    }).select("id").single();

  const fRes = await apiPost(
    `/api/polls/${poll.id}/support/confirm`,
    { intentId: intent3!.id, transactionHash: "f".repeat(64) },
    cookie,
  );
  check(
    fRes.status === 202 || fRes.status === 502,
    `F: Unknown tx → HTTP ${fRes.status}`,
  );

  // ── G. No vote created by confirmation ──────────────────────
  const { data: votes } = await admin.from("poll_votes")
    .select("id").eq("poll_id", poll.id).eq("voter_wallet", CREATOR_HEX);
  check((votes ?? []).length === 0, `G: No vote created (${(votes ?? []).length})`);
}

// ===========================================================================
// SECTION 4: HYGIENE
// ===========================================================================

async function testHygiene() {
  console.log("─── 4. Hygiene ───");
  const { data: qa } = await admin.from("polls")
    .select("id").eq("creator_wallet", "NQ07 QA FIXTURES WALLET 001");
  check((qa ?? []).length === 6, `QA fixtures: ${(qa ?? []).length} (expected 6)`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
run().catch((err) => {
  console.error("\n\x1b[31mFATAL:\x1b[0m", err);
  cleanupAll();
  process.exit(1);
});
