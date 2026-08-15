/**
 * V2B.1 — profile-edit UI logic tests (pure units; no server required).
 *
 * Covers the handle-availability tracker (debounce + stale-response safety),
 * the edit payload builder, save-response mapping, and the duplicate-save
 * guard. Browser interaction is not exercisable by the repo's script-based
 * convention, so the stateful logic is isolated and tested directly.
 *
 * Usage:
 *   npx tsx src/lib/api/v2b1-edit-form-test.ts
 */

import {
  HandleAvailabilityTracker,
  type AvailabilityFetcher,
} from "@/lib/profiles/handle-availability";
import {
  buildEditPayload,
  createSaveGuard,
  HANDLE_TAKEN_COPY,
  HANDLE_RESERVED_COPY,
  HANDLE_INVALID_COPY,
  DISPLAY_NAME_INVALID_COPY,
  profileViewPath,
  saveProfileEdit,
} from "@/lib/profiles/profile-edit";

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface PendingCheck {
  handle: string;
  resolve: (result: { available: boolean }) => void;
  reject: (err: Error) => void;
  aborted: boolean;
}

/** Manual-control fetcher: requests queue until the test resolves them. */
function manualFetcher() {
  const pending: PendingCheck[] = [];
  const fetcher: AvailabilityFetcher = (handle, signal) =>
    new Promise((resolve, reject) => {
      const entry: PendingCheck = {
        handle,
        resolve,
        reject,
        aborted: false,
      };
      signal.addEventListener("abort", () => {
        entry.aborted = true;
        reject(new Error("aborted"));
      });
      pending.push(entry);
    });
  return { pending, fetcher };
}

// ---------------------------------------------------------------------------
// Availability tracker — classification
// ---------------------------------------------------------------------------

function testClassification() {
  console.log("\n-- Availability: classification (no requests) --");
  const { pending, fetcher } = manualFetcher();
  const tracker = new HandleAvailabilityTracker({ debounceMs: 5, fetcher });
  tracker.setCurrentHandle("kaelah");

  tracker.update("");
  check(tracker.getState().status === "idle", "empty input → idle");
  tracker.update("   ");
  check(tracker.getState().status === "idle", "whitespace-only → idle");

  tracker.update("ab");
  check(tracker.getState().status === "invalid", "too short → invalid (no request)");
  tracker.update("Kae-Lah!");
  check(tracker.getState().status === "invalid", "symbols/uppercase → invalid (no request)");
  tracker.update("x".repeat(25));
  check(tracker.getState().status === "invalid", "too long → invalid (no request)");

  tracker.update("admin");
  check(tracker.getState().status === "reserved", "reserved handle → reserved (no request)");
  tracker.update("VOTUM");
  check(tracker.getState().status === "reserved", "reserved case-insensitive → reserved");

  tracker.update("kaelah");
  check(
    tracker.getState().status === "unchanged",
    "current handle → unchanged (no request)",
  );
  tracker.update(" Kaelah ");
  check(
    tracker.getState().status === "unchanged",
    "current handle with case/whitespace → unchanged",
  );

  check(pending.length === 0, "no availability requests fired for invalid/reserved/unchanged");

  tracker.dispose();
}

// ---------------------------------------------------------------------------
// Availability tracker — debounce
// ---------------------------------------------------------------------------

async function testDebounce() {
  console.log("\n-- Availability: debounce --");
  const calls: string[] = [];
  const fetcher: AvailabilityFetcher = async (handle) => {
    calls.push(handle);
    return { available: true };
  };
  const tracker = new HandleAvailabilityTracker({ debounceMs: 40, fetcher });

  tracker.update("kae");
  tracker.update("kae_l");
  tracker.update("kae_lah");
  await sleep(90);

  check(calls.length === 1, "rapid keystrokes → exactly one request");
  check(calls[0] === "kae_lah", "request fires for the final input only");
  check(tracker.getState().status === "available", "final input resolves to available");
  check(tracker.getState().handle === "kae_lah", "state describes the final input");

  tracker.dispose();
}

// ---------------------------------------------------------------------------
// Availability tracker — stale-response protection
// ---------------------------------------------------------------------------

async function testStaleResponses() {
  console.log("\n-- Availability: stale responses cannot overwrite newer input --");
  const { pending, fetcher } = manualFetcher();
  const tracker = new HandleAvailabilityTracker({ debounceMs: 0, fetcher });

  // "kae" fires request A immediately (debounce 0)…
  tracker.update("kae");
  await sleep(1);
  check(pending.length === 1 && pending[0].handle === "kae", "request A fired for 'kae'");

  // …then the user types more: request B for 'kaelah' supersedes A.
  tracker.update("kaelah");
  await sleep(1);
  check(pending.length === 2, "request B fired for 'kaelah'");
  check(pending[0].aborted === true, "request A aborted when newer input arrived");

  // B resolves second ("taken") — must win.
  pending[1].resolve({ available: false });
  await sleep(1);
  check(tracker.getState().handle === "kaelah", "state describes newer input");
  check(tracker.getState().status === "taken", "newer response applied (taken)");

  // A resolves late ("available") — must be ignored.
  pending[0].resolve({ available: true });
  await sleep(1);
  check(tracker.getState().handle === "kaelah", "late response A cannot replace handle");
  check(
    tracker.getState().status === "taken",
    "late response A cannot overwrite newer 'taken' state",
  );

  // A late rejection is equally harmless.
  tracker.update("kaelah2"); // request C
  await sleep(1);            // let C's debounce fire
  tracker.update("kaelah3"); // request D supersedes C
  await sleep(1);
  const cReq = pending[2];
  const dReq = pending[3];
  dReq.resolve({ available: true });
  await sleep(1);
  cReq.reject(new Error("network"));
  await sleep(1);
  check(
    tracker.getState().status === "available",
    "late failure of an older request is ignored",
  );

  tracker.dispose();
}

// ---------------------------------------------------------------------------
// Availability tracker — markTaken and failure
// ---------------------------------------------------------------------------

async function testMarkTakenAndFailure() {
  console.log("\n-- Availability: markTaken + endpoint failure --");
  const { pending, fetcher } = manualFetcher();
  const tracker = new HandleAvailabilityTracker({ debounceMs: 0, fetcher });

  tracker.update("race_me");
  await sleep(1);
  check(tracker.getState().status === "checking", "request in flight (checking)");

  // A concurrent save lost the race — force taken, cancel everything.
  tracker.markTaken("race_me");
  check(tracker.getState().status === "taken", "markTaken → taken");
  check(tracker.getState().handle === "race_me", "markTaken keeps canonical handle");
  check(pending[0].aborted === true, "in-flight request aborted by markTaken");
  pending[0].resolve({ available: true });
  await sleep(1);
  check(
    tracker.getState().status === "taken",
    "resolved stale request cannot flip taken back to available",
  );

  // Endpoint failure → unknown (advisory only; save still re-checks).
  const failing: AvailabilityFetcher = async () => {
    throw new Error("network down");
  };
  const tracker2 = new HandleAvailabilityTracker({ debounceMs: 0, fetcher: failing });
  tracker2.update("freebie");
  await sleep(1);
  check(tracker2.getState().status === "unknown", "endpoint failure → unknown");
  tracker2.dispose();
  tracker.dispose();
}

// ---------------------------------------------------------------------------
// Edit payload
// ---------------------------------------------------------------------------

function testPayload() {
  console.log("\n-- Edit payload builder --");
  const payload = buildEditPayload("  Kaelah  ", " KAELAH_01 ");
  check(payload.displayName === "Kaelah", "display name trimmed");
  check(payload.handle === "kaelah_01", "handle canonicalised to lowercase");
  check(
    JSON.stringify(Object.keys(payload)) === '["displayName","handle"]',
    "payload contains ONLY displayName + handle",
  );
  check(payload.walletAddress === undefined, "wallet address can never be in the payload");
  check(
    JSON.stringify(payload).includes("wallet") === false,
    "no wallet key by construction",
  );

  const cleared = buildEditPayload("   ", "  ");
  check(cleared.displayName === "", "empty display name → '' (clears to null server-side)");
  check(cleared.handle === "", "empty handle → '' (clears to null server-side)");

  check(profileViewPath("0123456789abcdef0123456789abcdef01234567") ===
    "/profile/0123456789abcdef0123456789abcdef01234567",
    "view-profile path uses the canonical wallet route");
}

// ---------------------------------------------------------------------------
// Save response mapping
// ---------------------------------------------------------------------------

async function testSaveMapping() {
  console.log("\n-- Save response mapping --");

  const okProfile = {
    walletAddress: "0123456789abcdef0123456789abcdef01234567",
    displayName: "Kaelah",
    handle: "kaelah",
    verifiedAt: "2026-08-14T00:00:00.000Z",
    joinedDate: "2026-08-14T00:00:00.000Z",
  };

  const makeFetcher = (status: number, body: unknown): ((url: string, init: RequestInit) => Promise<Response>) =>
    async () => new Response(JSON.stringify(body), { status });

  let ok = await saveProfileEdit(
    { displayName: "Kaelah", handle: "kaelah" },
    makeFetcher(200, { profile: okProfile }),
  );
  check(ok.ok === true && ok.ok && ok.profile.handle === "kaelah", "200 → ok with profile");

  ok = await saveProfileEdit(
    { displayName: "Kaelah", handle: "kaelah" },
    makeFetcher(200, {}),
  );
  check(ok.ok === false && ok.code === "server", "200 without profile → server error");

  const invalidHandle = await saveProfileEdit(
    { displayName: "Kaelah", handle: "x!" },
    makeFetcher(400, { error: "invalid_handle" }),
  );
  check(
    invalidHandle.ok === false && invalidHandle.code === "validation",
    "400 invalid_handle → validation",
  );
  check(
    invalidHandle.ok === false && invalidHandle.fields.handle === HANDLE_INVALID_COPY,
    "invalid handle copy shown inline",
  );

  const invalidDn = await saveProfileEdit(
    { displayName: "x".repeat(41), handle: "" },
    makeFetcher(400, { error: "invalid_display_name" }),
  );
  check(
    invalidDn.ok === false && invalidDn.fields.displayName === DISPLAY_NAME_INVALID_COPY,
    "invalid display name → field error copy",
  );

  const taken = await saveProfileEdit(
    { displayName: "", handle: "race_me" },
    makeFetcher(409, { error: "handle_taken" }),
  );
  check(
    taken.ok === false && taken.code === "conflict_handle_taken",
    "409 handle_taken mapped",
  );
  check(
    taken.ok === false && taken.fields.handle === HANDLE_TAKEN_COPY,
    "race copy: 'That handle was just taken. Try another one.'",
  );

  const reserved = await saveProfileEdit(
    { displayName: "", handle: "admin" },
    makeFetcher(409, { error: "reserved_handle" }),
  );
  check(
    reserved.ok === false && reserved.fields.handle === HANDLE_RESERVED_COPY,
    "409 reserved_handle → reserved copy",
  );

  const unauthorized = await saveProfileEdit(
    { displayName: "Kaelah", handle: "" },
    makeFetcher(401, { error: "session_missing" }),
  );
  check(
    unauthorized.ok === false && unauthorized.code === "unauthorized",
    "401 → unauthorized (form routes into onboarding)",
  );

  const network = await saveProfileEdit(
    { displayName: "Kaelah", handle: "" },
    async () => {
      throw new TypeError("fetch failed");
    },
  );
  check(
    network.ok === false && network.code === "network",
    "fetch failure → network (recoverable, values preserved)",
  );
  check(
    network.ok === false && network.message.length > 0,
    "network failure has human copy",
  );

  const server500 = await saveProfileEdit(
    { displayName: "Kaelah", handle: "" },
    makeFetcher(500, { error: "internal_error" }),
  );
  check(
    server500.ok === false && server500.code === "server",
    "500 → generic server error",
  );
}

// ---------------------------------------------------------------------------
// Duplicate-submission guard
// ---------------------------------------------------------------------------

function testSaveGuard() {
  console.log("\n-- Duplicate-submission guard --");
  const guard = createSaveGuard();
  check(guard.begin() === true, "first submission allowed");
  check(guard.begin() === false, "second concurrent submission blocked");
  check(guard.isBusy() === true, "busy while in flight");
  guard.end();
  check(guard.isBusy() === false, "released after completion");
  check(guard.begin() === true, "next submission allowed after release");
  guard.end();
}

// ---------------------------------------------------------------------------

async function run() {
  console.log("V2B.1 Profile-Edit UI Logic Suite");
  testClassification();
  await testDebounce();
  await testStaleResponses();
  await testMarkTakenAndFailure();
  testPayload();
  await testSaveMapping();
  testSaveGuard();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
