/**
 * V2B.1 — Backward-compatibility regression gate.
 *
 * Proves onboarding/profiles did NOT weaken the pre-existing product:
 * the cryptographic challenge → signature → verify → session flow is
 * unchanged (real @nimiq/core keypair, real HTTP round-trips), the wallet
 * remains the immutable identity for one-wallet-one-vote, support truth
 * is untouched, and publish / My Polls / public reads still behave.
 *
 * Usage:
 *   npx tsx src/lib/api/v2b1-backward-test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "./load-local-env";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { KeyPair, Address } from "@nimiq/core";

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

import { cleanupTestWallet } from "./local-test-cleanup";
import {
  admin,
  NEXT_BASE,
  startNextDev,
  stopNextDev,
  sha256Hex,
  apiGet,
  apiPost,
  deleteTestSession,
} from "./v2b1-dev-server";

export async function apiPut(
  path: string,
  body: unknown,
  cookie?: string,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = `votum_session=${cookie}`;
  const res = await fetch(`${NEXT_BASE}${path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* ok */ }
  return { status: res.status, data };
}

/** Best-effort residue hygiene: wallet_challenges is not covered by cleanupTestWallet. */
function cleanupChallenges(wallet: string): void {
  try {
    execFileSync(
      "docker",
      ["exec", "supabase_db_votum", "psql", "-U", "postgres", "-d", "postgres",
        "-c", `DELETE FROM public.wallet_challenges WHERE wallet_address = '${wallet}';`],
      { stdio: "ignore" },
    );
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Real Nimiq signing — mirrors the app's official signed-message envelope
// (src/lib/nimiq/server-crypto.ts). Success of the round-trip proves the
// test envelope matches the server's verification exactly.
// ---------------------------------------------------------------------------

const SIGNED_MESSAGE_PREFIX = "\x16Nimiq Signed Message:\n";

function buildSignedMessageHash(message: string): Uint8Array {
  const prefixBytes = new TextEncoder().encode(SIGNED_MESSAGE_PREFIX);
  const lengthBytes = new TextEncoder().encode(String(message.length));
  const messageBytes = new TextEncoder().encode(message);
  const payload = new Uint8Array(prefixBytes.length + lengthBytes.length + messageBytes.length);
  payload.set(prefixBytes, 0);
  payload.set(lengthBytes, prefixBytes.length);
  payload.set(messageBytes, prefixBytes.length + lengthBytes.length);
  return new Uint8Array(createHash("sha256").update(payload).digest());
}

interface VerifiedSession {
  cookie: string;
  wallet: string;
}

/** Full real verification: challenge → sign → verify → capture session cookie. */
async function verifyRealWallet(keyPair: KeyPair): Promise<VerifiedSession> {
  const address = keyPair.toAddress().toHex();
  const challengeRes = await fetch(`${NEXT_BASE}/api/wallet-proof/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
  if (!challengeRes.ok) throw new Error(`challenge failed: ${challengeRes.status}`);
  const { challengeId, message } = await challengeRes.json();

  const hash = buildSignedMessageHash(message);
  const signature = keyPair.sign(hash).toHex();
  const publicKey = keyPair.publicKey.toHex();

  const verifyRes = await fetch(`${NEXT_BASE}/api/wallet-proof/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId, address, publicKey, signature }),
  });
  if (!verifyRes.ok) throw new Error(`verify failed: ${verifyRes.status}`);

  const setCookies = verifyRes.headers.getSetCookie?.() ?? [];
  const cookieHeader = setCookies.find((c) => c.startsWith("votum_session="));
  if (!cookieHeader) throw new Error("no votum_session cookie set");
  return { cookie: cookieHeader.split(";")[0].split("=")[1], wallet: address };
}

async function rawVerify(
  body: Record<string, string>,
): Promise<{ status: number; data: any; cookies: string[] }> {
  const res = await fetch(`${NEXT_BASE}/api/wallet-proof/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* ok */ }
  return { status: res.status, data, cookies: res.headers.getSetCookie?.() ?? [] };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function createPoll(creator: string, question: string, opts: string[], overrides: Record<string, unknown> = {}) {
  const row = await admin.from("polls").insert({
    creator_wallet: creator,
    question,
    mode: "creator_support",
    destination_wallet: creator,
    destination_purpose: "test",
    min_nim_luna: 10,
    fairness_mode: "one_wallet_one_vote",
    status: "live",
    is_public: true,
    category: "other",
    format: "decision",
    ends_at: new Date(Date.now() + 86400000).toISOString(),
    starts_at: new Date(Date.now() - 86400000).toISOString(),
    ...overrides,
  }).select("id").single();
  if (!row.data) return null;
  const pollId = row.data.id as string;
  const optsRes = await admin.from("poll_options").insert(
    opts.map((label, i) => ({ poll_id: pollId, label, sort_order: i })),
  ).select("id");
  return { pollId, optionIds: (optsRes.data ?? []).map((o: any) => o.id as string) };
}

async function voteCount(wallet: string): Promise<number> {
  const { count } = await admin
    .from("poll_votes")
    .select("id", { count: "exact", head: true })
    .eq("voter_wallet", wallet);
  return count ?? -1;
}

/** UUID v4 — required by the publish idempotency-key contract. */
function uuidV4(): string {
  return randomBytes(16).toString("hex").replace(
    /(.{8})(.{4})(.{4})(.{4})(.{12})/,
    "$1-$2-$3-$4-$5",
  );
}

// ---------------------------------------------------------------------------
// A. Wallet verification crypto regression (unchanged challenge→verify flow)
// ---------------------------------------------------------------------------

async function testVerificationCrypto(wallets: string[]) {
  console.log("\n-- Wallet verification crypto regression --");

  const kpA = KeyPair.generate();
  const walletA = kpA.toAddress().toHex();
  wallets.push(walletA);

  // 1. Challenge is issued and short-lived (TTL 5 min).
  const c1 = await fetch(`${NEXT_BASE}/api/wallet-proof/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: walletA }),
  });
  check(c1.status === 200, "challenge issued → 200");
  const c1Data = await c1.json();
  const ttlMs = new Date(c1Data.expiresAt).getTime() - Date.now();
  check(ttlMs > 0 && ttlMs <= 5 * 60 * 1000 + 30_000, "challenge short-lived (≤ 5 min TTL)");
  check(typeof c1Data.challengeId === "string" && typeof c1Data.message === "string", "challenge returns id + signable message");

  // 2. Valid signature → verified + session cookie set.
  const sessionA = await verifyRealWallet(kpA);
  check(sessionA.wallet === walletA, "real verify succeeds and returns the canonical wallet");
  check(typeof sessionA.cookie === "string" && sessionA.cookie.length > 20, "votum_session cookie issued");

  // 3. Reused (consumed) challenge → 409.
  const hash = buildSignedMessageHash(c1Data.message);
  const reuse = await rawVerify({
    challengeId: c1Data.challengeId,
    address: walletA,
    publicKey: kpA.publicKey.toHex(),
    signature: kpA.sign(hash).toHex(),
  });
  check(reuse.status === 409 && reuse.data?.error === "challenge_already_used", "reused challenge → 409 challenge_already_used");

  // 4. Invalid signature → rejected.
  const c2 = await fetch(`${NEXT_BASE}/api/wallet-proof/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: walletA }),
  }).then((r) => r.json());
  const badSig = await rawVerify({
    challengeId: c2.challengeId,
    address: walletA,
    publicKey: kpA.publicKey.toHex(),
    signature: kpA.sign(buildSignedMessageHash("tampered message")).toHex(),
  });
  check(badSig.status === 400 && badSig.data?.error === "signature_verification_failed", "invalid signature → 400 signature_verification_failed");

  // 5. Wrong key (signer mismatch) → rejected.
  const kpB = KeyPair.generate();
  const c3 = await fetch(`${NEXT_BASE}/api/wallet-proof/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: walletA }),
  }).then((r) => r.json());
  const wrongKey = await rawVerify({
    challengeId: c3.challengeId,
    address: walletA,
    publicKey: kpB.publicKey.toHex(),
    signature: kpB.sign(buildSignedMessageHash(c3.message)).toHex(),
  });
  check(wrongKey.status === 400 && wrongKey.data?.error === "signer_address_mismatch", "wrong key → 400 signer_address_mismatch");

  // 6. Single-use: a second challenge for the same wallet voids the first.
  await fetch(`${NEXT_BASE}/api/wallet-proof/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: walletA }),
  });
  const voided = await rawVerify({
    challengeId: c3.challengeId, // superseded by c4
    address: walletA,
    publicKey: kpA.publicKey.toHex(),
    signature: kpA.sign(buildSignedMessageHash(c3.message)).toHex(),
  });
  check(voided.status === 409 && voided.data?.error === "challenge_already_used", "superseded challenge → 409 challenge_already_used");

  // 7. Expired challenge → rejected.
  // (created_at must also be set: CHECK expires_at > created_at.)
  const expired = await admin.from("wallet_challenges").insert({
    wallet_address: walletA,
    message: "expired test message",
    origin: "localhost",
    expires_at: new Date(Date.now() - 60_000).toISOString(),
    created_at: new Date(Date.now() - 120_000).toISOString(),
  }).select("id").single();
  const expiredVerify = await rawVerify({
    challengeId: expired.data?.id as string,
    address: walletA,
    publicKey: kpA.publicKey.toHex(),
    signature: kpA.sign(buildSignedMessageHash("expired test message")).toHex(),
  });
  check(expiredVerify.status === 400 && expiredVerify.data?.error === "challenge_expired", "expired challenge → 400 challenge_expired");

  // 8. Session endpoint still works; authorization still enforced.
  const sessionCheck = await fetch(`${NEXT_BASE}/api/wallet-proof/session`, {
    headers: { Cookie: `votum_session=${sessionA.cookie}` },
  }).then((r) => r.json());
  // The session endpoint returns the user-friendly NQ form so the client can
  // compare it against the SDK's activeAccount (see #21 canonical fix).
  const sessionNqAddress = Address.fromString(walletA).toUserFriendlyAddress();
  check(sessionCheck.verified === true, "GET /api/wallet-proof/session → verified");
  check(
    sessionCheck.walletAddress?.trim().toLowerCase() === sessionNqAddress.trim().toLowerCase(),
    "session reports the verified wallet",
  );
  const bootNoSession = await apiPost("/api/profile/bootstrap", {});
  check(bootNoSession.status === 401, "getVerifiedWalletSession still gates (401 without session)");
  const bootWithSession = await apiPost("/api/profile/bootstrap", {}, sessionA.cookie);
  check(bootWithSession.status === 200, "verified session still authorizes bootstrap");
  check(
    bootWithSession.data?.profile?.walletAddress === walletA,
    "bootstrap uses the session wallet",
  );

  await deleteTestSession(sessionA.cookie);
}

// ---------------------------------------------------------------------------
// B. Profile / session separation
// ---------------------------------------------------------------------------

async function testProfileSessionSeparation(wallets: string[]) {
  console.log("\n-- Profile vs session separation --");

  const kpX = KeyPair.generate();
  const walletX = kpX.toAddress().toHex();
  const kpY = KeyPair.generate();
  const walletY = kpY.toAddress().toHex();
  wallets.push(walletX, walletY);

  const sessionX = await verifyRealWallet(kpX);
  await apiPost("/api/profile/bootstrap", {}, sessionX.cookie);
  await admin
    .from("participant_profiles")
    .update({ display_name: "Backward X", handle: `bw_${sha256Hex(walletX).slice(0, 8)}`, updated_at: new Date().toISOString() })
    .eq("wallet_address", walletX);

  // 1. Profile exists while the user is logged out.
  const publicProfile = await apiGet(`/api/profile?wallet=${walletX}`);
  check(publicProfile.status === 200, "public profile readable with no session (logged out)");

  // 2. Profile existence grants no authenticated action.
  const anonEdit = await apiPut("/api/profile/me", { displayName: "Hacker" });
  check(anonEdit.status === 401, "no session → cannot edit (401)");

  // 3. Arbitrary body wallet cannot choose the edit target.
  const spoof = await apiPut("/api/profile/me", { displayName: "Spoofed", wallet: walletY }, sessionX.cookie);
  check(spoof.status === 200, "edit with body succeeds");
  check(spoof.data?.profile?.walletAddress === walletX, "edit target is ALWAYS the session wallet (body wallet ignored)");
  const yProfile = await admin.from("participant_profiles").select("display_name").eq("wallet_address", walletY).maybeSingle();
  check(yProfile.data === null || yProfile.data.display_name === null, "other wallet untouched by spoofed body");

  // 4. Switching wallets does not inherit identity: a new session owns its own profile.
  const sessionY = await verifyRealWallet(kpY);
  const yBoot = await apiPost("/api/profile/bootstrap", {}, sessionY.cookie);
  check(yBoot.data?.profile?.walletAddress === walletY, "wallet Y session bootstraps wallet Y only");
  const yEdit = await apiPut("/api/profile/me", { displayName: "Backward Y" }, sessionY.cookie);
  check(yEdit.data?.profile?.walletAddress === walletY, "wallet Y edits its own profile only");

  // 5. Same wallet + session restore behaves identically.
  const xAfterY = await apiGet(`/api/profile?wallet=${walletX}`);
  check(xAfterY.data?.profile?.displayName !== "Backward Y", "wallet Y edits never leak into wallet X profile");
  const sessionX2 = await verifyRealWallet(kpX); // re-verify same wallet
  const bootX2 = await apiPost("/api/profile/bootstrap", {}, sessionX2.cookie);
  check(bootX2.data?.profile?.walletAddress === walletX, "re-verified same wallet restores its own session");
  check(
    bootX2.data?.profile?.verifiedAt === publicProfile.data?.profile?.verifiedAt,
    "bootstrap idempotent — verified_at unchanged for existing profile",
  );
  check(
    bootX2.data?.profile?.displayName === "Spoofed",
    "existing display name preserved across re-verification",
  );

  await deleteTestSession(sessionX.cookie);
  await deleteTestSession(sessionY.cookie);
  await deleteTestSession(sessionX2.cookie);
}

// ---------------------------------------------------------------------------
// C. One-wallet-one-vote regression
// ---------------------------------------------------------------------------

async function testOneWalletOneVote(wallets: string[]) {
  console.log("\n-- One-wallet-one-vote regression --");

  const kpV = KeyPair.generate();
  const walletV = kpV.toAddress().toHex();
  wallets.push(walletV);

  const sessionV = await verifyRealWallet(kpV);
  const poll = await createPoll(walletV, "T11B one-wallet-one-vote question?", ["T11BOptA", "T11BOptB"]);
  if (!poll) { check(false, "poll fixture"); return; }

  const cast = (optionId: string, cookie: string) =>
    fetch(`${NEXT_BASE}/api/polls/${poll.pollId}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `votum_session=${cookie}` },
      body: JSON.stringify({ optionId }),
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

  const first = await cast(poll.optionIds[0], sessionV.cookie);
  check(first.status === 201 && first.data?.resultKind === "created", "first vote → 201 created");
  const firstVoteId = first.data?.vote?.id;

  const replay = await cast(poll.optionIds[0], sessionV.cookie);
  check(
    replay.status === 200 && replay.data?.resultKind === "replay" && replay.data?.vote?.id === firstVoteId,
    "same-wallet same-option replay → replay with the SAME vote id",
  );

  const other = await cast(poll.optionIds[1], sessionV.cookie);
  check(other.status === 409 && other.data?.error === "already_voted", "same-wallet other-option → 409 already_voted");

  check((await voteCount(walletV)) === 1, "exactly one vote row per wallet");

  // Bootstrap / profile edits must not create another voting identity.
  await apiPost("/api/profile/bootstrap", {}, sessionV.cookie);
  check((await voteCount(walletV)) === 1, "bootstrap does not create another vote entitlement");
  await apiPut("/api/profile/me", { handle: "t11b_voter", displayName: "T11B Voter" }, sessionV.cookie);
  check((await voteCount(walletV)) === 1, "handle rename + display-name change do not change vote identity");
  const afterRename = await cast(poll.optionIds[0], sessionV.cookie);
  check(afterRename.data?.resultKind === "replay", "voting identity unchanged after rename — still replay");

  // Reconnect (session re-created) still grants no second vote.
  await deleteTestSession(sessionV.cookie);
  const sessionV2 = await verifyRealWallet(kpV);
  const afterReconnect = await cast(poll.optionIds[0], sessionV2.cookie);
  check(afterReconnect.data?.resultKind === "replay", "reconnect does not create a second vote entitlement");
  check((await voteCount(walletV)) === 1, "vote row count still exactly 1 after reconnect");

  await deleteTestSession(sessionV2.cookie);
}

// ---------------------------------------------------------------------------
// D. Support regression
// ---------------------------------------------------------------------------

async function testSupportRegression(wallets: string[]) {
  console.log("\n-- Support regression --");

  const kpS = KeyPair.generate();
  const walletS = kpS.toAddress().toHex();
  wallets.push(walletS);

  const sessionS = await verifyRealWallet(kpS);
  await apiPost("/api/profile/bootstrap", {}, sessionS.cookie);

  const poll = await createPoll(walletS, "T11B support question?", ["T11BSupA", "T11BSupB"]);
  if (!poll) { check(false, "support poll fixture"); return; }
  const { count: votesBefore } = await admin
    .from("poll_votes")
    .select("id", { count: "exact", head: true })
    .eq("poll_id", poll.pollId);

  // Pending intent (no contribution) + confirmed contribution.
  await admin.from("nim_support_intents").insert({
    reference: `t11b-pend-${sha256Hex(walletS).slice(0, 12)}`,
    poll_id: poll.pollId,
    option_id: poll.optionIds[0],
    initiator_wallet: walletS,
    supporter_wallet: walletS,
    recipient_wallet: walletS,
    amount_luna: 999999,
    memo: "t11b test",
    status: "pending",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
  const confirmedIntent = await admin.from("nim_support_intents").insert({
    reference: `t11b-conf-${sha256Hex(walletS).slice(0, 12)}`,
    poll_id: poll.pollId,
    option_id: poll.optionIds[0],
    initiator_wallet: walletS,
    supporter_wallet: walletS,
    recipient_wallet: walletS,
    amount_luna: 500000,
    memo: "t11b test",
    status: "confirmed",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  }).select("id").single();
  await admin.from("nim_contributions").insert({
    intent_id: confirmedIntent.data?.id as string,
    poll_id: poll.pollId,
    option_id: poll.optionIds[0],
    supporter_wallet: walletS,
    recipient_wallet: walletS,
    amount_luna: 500000,
    transaction_hash: `tx-t11b-${sha256Hex(walletS).slice(0, 20)}`,
  });

  const profile = await apiGet(`/api/profile?wallet=${walletS}`);
  check(profile.status === 200, "public profile resolves after support fixtures");
  check(
    profile.data?.stats?.nimSupportedLuna === "500000",
    "public NIM supported = confirmed-only 500000 (pending 999999 excluded)",
  );
  check(profile.data?.stats?.nimEarnedLuna === "0", "nimEarnedLuna exactly 0 (no reward ledger)");

  const { count: votesAfterPending } = await admin
    .from("poll_votes")
    .select("id", { count: "exact", head: true })
    .eq("poll_id", poll.pollId);
  check(votesAfterPending === votesBefore, "support intents/contributions never create votes");

  // Profile editing cannot alter support history.
  const contribCount = () =>
    admin.from("nim_contributions").select("id", { count: "exact", head: true }).eq("supporter_wallet", walletS);
  const beforeEdit = (await contribCount()).count ?? -1;
  await apiPut("/api/profile/me", { displayName: "Support Tester", handle: "t11b_support" }, sessionS.cookie);
  const afterEdit = (await contribCount()).count ?? -2;
  check(beforeEdit === afterEdit, "profile editing cannot alter support history");

  await deleteTestSession(sessionS.cookie);
}

// ---------------------------------------------------------------------------
// E. Publish + My Polls + public reads regression
// ---------------------------------------------------------------------------

async function testProductFlows(wallets: string[]) {
  console.log("\n-- Publish / My Polls / public reads regression --");

  const kpP = KeyPair.generate();
  const walletP = kpP.toAddress().toHex();
  wallets.push(walletP);

  const sessionP = await verifyRealWallet(kpP);
  await apiPost("/api/profile/bootstrap", {}, sessionP.cookie);

  // Publish through the real route (create-page contract).
  const publishRes = await fetch(`${NEXT_BASE}/api/polls/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `votum_session=${sessionP.cookie}` },
    body: JSON.stringify({
      category: "other",
      format: "decision",
      question: "T11B publish regression question?",
      description: null,
      options: ["T11BPubA", "T11BPubB"],
      mode: "creator_support",
      destinationWallet: walletP,
      destinationPurpose: "test",
      minimumNim: "0.001",
      fairnessMode: "one_wallet_one_vote",
      duration: "7days",
      idempotencyKey: uuidV4(),
    }),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
  check(publishRes.status === 201, "publish route → 201 created");
  const publishedId = publishRes.data?.poll?.id as string | undefined;
  check(typeof publishedId === "string", "publish returns a poll id");
  check((await voteCount(walletP)) === 0, "publishing alone creates no vote");

  // My Polls (owner, session-scoped).
  const myPolls = await apiGet("/api/me/polls", sessionP.cookie);
  check(myPolls.status === 200, "My Polls → 200 with session");
  check(
    Array.isArray(myPolls.data?.polls) && myPolls.data.polls.some((p: any) => p.id === publishedId),
    "My Polls contains the published poll",
  );
  const myPollsAnon = await apiGet("/api/me/polls");
  check(myPollsAnon.status === 401, "My Polls → 401 without session (unchanged gate)");

  // Public results + Explore still read the published poll.
  if (publishedId) {
    const results = await apiGet(`/api/polls/${publishedId}/results`);
    check(results.status === 200, "public poll results → 200");
    const explore = await apiGet("/api/explore?q=T11B");
    check(explore.status === 200, "Explore → 200");
    check(
      JSON.stringify(explore.data).includes("T11B publish regression question?"),
      "published poll discoverable in Explore search",
    );
  }

  // Public poll page renders (no 500).
  if (publishedId) {
    const page = await fetch(`${NEXT_BASE}/polls/${publishedId}`, {
      signal: AbortSignal.timeout(90000),
      redirect: "manual",
    });
    check(page.status === 200, "public poll page → 200");
  }

  await deleteTestSession(sessionP.cookie);
}

// ---------------------------------------------------------------------------
// F. Landing + route smoke (no unexpected 500s)
// ---------------------------------------------------------------------------

async function testRouteSmoke(wallets: string[]) {
  console.log("\n-- Route smoke (no unexpected 500s) --");

  const kpR = KeyPair.generate();
  const walletR = kpR.toAddress().toHex();
  wallets.push(walletR);
  const sessionR = await verifyRealWallet(kpR);
  await apiPost("/api/profile/bootstrap", {}, sessionR.cookie);
  await admin
    .from("participant_profiles")
    .update({ display_name: "Smoke Tester", handle: `smoke_${sha256Hex(walletR).slice(0, 8)}`, updated_at: new Date().toISOString() })
    .eq("wallet_address", walletR);

  const routes: Array<[string, number]> = [
    ["/", 200],
    ["/explore", 200],
    ["/how-it-works", 200],
    ["/create", 200],
    ["/my-polls", 200],
    [`/profile/${walletR}`, 200],
    [`/u/smoke_${sha256Hex(walletR).slice(0, 8)}`, 200],
    ["/profile/edit", 200],
  ];
  for (const [path, expected] of routes) {
    const res = await fetch(`${NEXT_BASE}${path}`, {
      signal: AbortSignal.timeout(90000),
      redirect: "manual",
    });
    check(res.status === expected, `${path} → ${res.status} (expected ${expected})`);
  }

  // No route may return an unexpected 500.
  const pages = await Promise.all(
    routes.map(([path]) =>
      fetch(`${NEXT_BASE}${path}`, { signal: AbortSignal.timeout(90000) }).then((r) => r.status),
    ),
  );
  check(pages.every((s) => s !== 500), "no route returned an unexpected 500");

  await deleteTestSession(sessionR.cookie);
}

// ---------------------------------------------------------------------------

async function run() {
  console.log("V2B.1 Backward-Compatibility Suite");
  const wallets: string[] = [];
  console.log("Starting Next.js dev server...");
  await startNextDev();
  console.log("Next.js ready.\n");
  try {
    await testVerificationCrypto(wallets);
    await testProfileSessionSeparation(wallets);
    await testOneWalletOneVote(wallets);
    await testSupportRegression(wallets);
    await testProductFlows(wallets);
    await testRouteSmoke(wallets);
  } finally {
    for (const w of wallets) cleanupTestWallet(w);
    for (const w of wallets) cleanupChallenges(w);
    stopNextDev();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
