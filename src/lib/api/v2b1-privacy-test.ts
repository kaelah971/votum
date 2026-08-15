/**
 * V2B.1 — Privacy hard gate.
 *
 * Proves the public profile surface exposes ONLY the approved public
 * boundary (is_public = true AND status IN ('live','closed')) in both the
 * API response and the rendered public profile HTML. Distinctive fixture
 * strings make any leakage obvious.
 *
 * Usage:
 *   npx tsx src/lib/api/v2b1-privacy-test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "./load-local-env";
import { createClient } from "@supabase/supabase-js";

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
  randomNimiqHex,
  createTestSession,
  deleteTestSession,
  sha256Hex,
  apiGet,
  apiPost,
} from "./v2b1-dev-server";

// Distinctive fixture strings — if any of these appear, the boundary broke.
const LIVE_QUESTION = "T11P public live question?";
const CLOSED_QUESTION = "T11P public closed question?";
const PRIVATE_QUESTION = "T11P private secret question?";
const DRAFT_QUESTION = "T11P draft question?";
const CHOSEN_LIVE = "T11PCHOSENLIVE";
const UNCHOSEN_LIVE = "T11PUNCHOSENLIVE";
const CHOSEN_CLOSED = "T11PCHOSENCLOSED";
const UNCHOSEN_CLOSED = "T11PUNCHOSENCLOSED";
const PRIVATE_OPTION = "T11PPRIVATEOPT";

async function fetchHtml(path: string): Promise<{ status: number; html: string }> {
  const res = await fetch(`${NEXT_BASE}${path}`, {
    signal: AbortSignal.timeout(90000),
    redirect: "manual",
  });
  return { status: res.status, html: await res.text() };
}

function textOf(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = text.indexOf(needle, idx + needle.length);
  }
  return count;
}

async function createPoll(overrides: Record<string, unknown>, options: string[]) {
  const row = await admin.from("polls").insert({
    creator_wallet: overrides.creator_wallet,
    question: overrides.question,
    mode: "creator_support",
    destination_wallet: overrides.creator_wallet as string,
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
  const opts = await admin.from("poll_options").insert(
    options.map((label, i) => ({ poll_id: pollId, label, sort_order: i })),
  ).select("id");
  return { pollId, optionIds: (opts.data ?? []).map((o: any) => o.id as string) };
}

async function testPrivacyBoundary(wallets: string[]) {
  console.log("\n-- Privacy hard gate (API + rendered HTML) --");

  const wallet = randomNimiqHex();
  wallets.push(wallet);
  const handle = `priv_${sha256Hex(wallet).slice(0, 8)}`;

  const token = await createTestSession(wallet);
  await apiPost("/api/profile/bootstrap", {}, token);
  await admin
    .from("participant_profiles")
    .update({ display_name: "Privacy Tester", handle, updated_at: new Date().toISOString() })
    .eq("wallet_address", wallet);

  // Public live poll — vote + confirmed contribution + pending/failed intents.
  const live = await createPoll({ creator_wallet: wallet, question: LIVE_QUESTION }, [CHOSEN_LIVE, UNCHOSEN_LIVE]);
  if (!live) { check(false, "live poll fixture"); return; }
  await admin.from("poll_votes").insert({ poll_id: live.pollId, option_id: live.optionIds[0], voter_wallet: wallet });

  const confirmedIntent = await admin.from("nim_support_intents").insert({
    reference: `t11p-conf-${sha256Hex(wallet).slice(0, 12)}`,
    poll_id: live.pollId,
    option_id: live.optionIds[0],
    initiator_wallet: wallet,
    supporter_wallet: wallet,
    recipient_wallet: wallet,
    amount_luna: 100000,
    memo: "t11p test",
    status: "confirmed",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  }).select("id").single();
  await admin.from("nim_contributions").insert({
    intent_id: confirmedIntent.data?.id as string,
    poll_id: live.pollId,
    option_id: live.optionIds[0],
    supporter_wallet: wallet,
    recipient_wallet: wallet,
    amount_luna: 100000,
    transaction_hash: `tx-t11p-${sha256Hex(wallet).slice(0, 20)}`,
  });

  // Pending + failed intents (no contribution rows) — must not inflate totals.
  await admin.from("nim_support_intents").insert({
    reference: `t11p-pend-${sha256Hex(wallet).slice(0, 12)}`,
    poll_id: live.pollId,
    option_id: live.optionIds[1],
    initiator_wallet: wallet,
    supporter_wallet: wallet,
    recipient_wallet: wallet,
    amount_luna: 200000,
    memo: "t11p test",
    status: "pending",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
  await admin.from("nim_support_intents").insert({
    reference: `t11p-fail-${sha256Hex(wallet).slice(0, 12)}`,
    poll_id: live.pollId,
    option_id: live.optionIds[1],
    initiator_wallet: wallet,
    supporter_wallet: wallet,
    recipient_wallet: wallet,
    amount_luna: 300000,
    memo: "t11p test",
    status: "failed",
    expires_at: new Date(Date.now() - 3600000).toISOString(),
  });

  // Public closed poll — vote only.
  const closed = await createPoll(
    {
      creator_wallet: wallet,
      question: CLOSED_QUESTION,
      status: "closed",
      ends_at: new Date(Date.now() - 3600000).toISOString(),
      starts_at: new Date(Date.now() - 172800000).toISOString(),
    },
    [CHOSEN_CLOSED, UNCHOSEN_CLOSED],
  );
  if (!closed) { check(false, "closed poll fixture"); return; }
  await admin.from("poll_votes").insert({ poll_id: closed.pollId, option_id: closed.optionIds[0], voter_wallet: wallet });

  // Private live poll — must never appear.
  const privatePoll = await createPoll(
    { creator_wallet: wallet, question: PRIVATE_QUESTION, is_public: false },
    [PRIVATE_OPTION],
  );
  if (!privatePoll) { check(false, "private poll fixture"); return; }
  await admin.from("poll_votes").insert({ poll_id: privatePoll.pollId, option_id: privatePoll.optionIds[0], voter_wallet: wallet });

  // Draft poll (is_public true but status draft) — must never appear.
  const draftPoll = await createPoll(
    { creator_wallet: wallet, question: DRAFT_QUESTION, status: "draft", is_public: true },
    ["T11PDRAFTOPT"],
  );
  if (!draftPoll) { check(false, "draft poll fixture"); return; }
  await admin.from("poll_votes").insert({ poll_id: draftPoll.pollId, option_id: draftPoll.optionIds[0], voter_wallet: wallet });

  // ---- API response (public, no session) ----
  const api = await apiGet(`/api/profile?wallet=${wallet}`);
  check(api.status === 200, "public profile API → 200 without any session");
  check(api.data?.stats?.pollsCreated === 2, "pollsCreated = 2 (live + closed only)");
  check(api.data?.stats?.participations === 2, "participations = 2 (public votes only)");
  check(api.data?.stats?.nimSupportedLuna === "100000", "nimSupportedLuna = confirmed-only 100000");
  check(api.data?.stats?.nimEarnedLuna === "0", "nimEarnedLuna truthful 0");
  check(api.data?.activity?.length === 4, "activity = 4 public items (private + draft excluded)");
  check(api.data?.activity?.length <= 12, "activity bounded at 12");
  check(
    api.data?.activity?.every((a: any) => a.kind === "created" || a.kind === "participated"),
    "activity kinds are created/participated only",
  );

  const json = JSON.stringify(api.data);
  check(json.includes(LIVE_QUESTION), "public live poll title appears");
  check(json.includes(CLOSED_QUESTION), "public closed poll title appears");
  check(json.includes(PRIVATE_QUESTION) === false, "private poll title absent");
  check(json.includes(DRAFT_QUESTION) === false, "draft poll title absent");
  check(json.includes(CHOSEN_LIVE) === false, "chosen option text absent (API)");
  check(json.includes(UNCHOSEN_LIVE) === false, "unchosen option text absent (API)");
  check(json.includes(CHOSEN_CLOSED) === false, "closed chosen option absent (API)");
  check(json.includes(UNCHOSEN_CLOSED) === false, "closed unchosen option absent (API)");
  check(json.includes(PRIVATE_OPTION) === false, "private option absent (API)");
  check(json.includes("option_id") === false, "option_id absent (API)");
  check(json.includes("optionId") === false, "optionId absent (API)");
  check(json.includes("option") === false, "no 'option' key anywhere (API)");
  check(json.includes("token_hash") === false, "token hash absent (API)");
  check(json.includes("session") === false, "session data absent (API)");
  check(json.includes("challenge") === false, "challenge data absent (API)");
  check(json.includes("signature") === false, "signature payload absent (API)");
  check(json.includes("supabase") === false, "supabase internals absent (API)");
  check(json.includes("service_role") === false, "service-role values absent (API)");
  check(json.includes("auth") === false, "auth metadata absent (API)");

  // ---- Rendered public profile HTML (no session) ----
  const page = await fetchHtml(`/profile/${wallet}`);
  check(page.status === 200, "public profile page → 200 without any session");
  const text = textOf(page.html);
  check(text.includes(LIVE_QUESTION), "rendered: public live title appears");
  check(text.includes(CLOSED_QUESTION), "rendered: public closed title appears");
  check(text.includes(PRIVATE_QUESTION) === false, "rendered: private title absent");
  check(text.includes(DRAFT_QUESTION) === false, "rendered: draft title absent");
  check(text.includes(CHOSEN_LIVE) === false, "rendered: chosen option absent");
  check(text.includes(UNCHOSEN_LIVE) === false, "rendered: unchosen option absent");
  check(text.includes(CHOSEN_CLOSED) === false, "rendered: closed chosen absent");
  check(text.includes(UNCHOSEN_CLOSED) === false, "rendered: closed unchosen absent");
  check(text.includes(PRIVATE_OPTION) === false, "rendered: private option absent");
  check(text.includes("option_id") === false, "rendered: option_id absent");
  check(text.includes("optionId") === false, "rendered: optionId absent");
  check(text.includes("token_hash") === false, "rendered: token hash absent");
  check(text.includes("challenge") === false, "rendered: challenge data absent");
  check(
    countOccurrences(text, "Created \u201C") + countOccurrences(text, "Participated in \u201C") ===
      api.data.activity.length,
    "rendered: exactly the bounded API activity (no per-item fetches)",
  );

  // ---- Direct anon DB access blocked (RLS) ----
  const pubUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
  const pubKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  const anon = createClient(pubUrl, pubKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: "public" },
  });
  const anonSelect = await anon.from("participant_profiles").select("wallet_address").eq("wallet_address", wallet);
  check(anonSelect.error !== null, "anon cannot SELECT participant_profiles directly (RLS revoked)");
  const anonVotes = await anon.from("poll_votes").select("option_id").eq("poll_id", live.pollId);
  check(anonVotes.error !== null, "anon cannot SELECT poll_votes directly");

  await deleteTestSession(token);
}

async function run() {
  console.log("V2B.1 Privacy Suite");
  const wallets: string[] = [];
  console.log("Starting Next.js dev server...");
  await startNextDev();
  console.log("Next.js ready.\n");
  try {
    await testPrivacyBoundary(wallets);
  } finally {
    for (const w of wallets) cleanupTestWallet(w);
    stopNextDev();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
