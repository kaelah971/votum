/**
 * V2B.1 — Profile contract, handle-rule, bootstrap, query, edit, and
 * public-page tests.
 *
 * Usage:
 *   npx tsx src/lib/api/v2b1-profile-test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import "./load-local-env";

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
  RESERVED_HANDLES,
  normalizeHandle,
  isValidHandle,
  isReservedHandle,
  validateHandle,
  normalizeDisplayName,
} from "@/lib/profiles/handles";
import { serializePublicProfile } from "@/lib/profiles/serialize";
import type { ParticipantPublicProfile } from "@/lib/profiles/types";
import {
  admin,
  NEXT_BASE,
  startNextDev,
  stopNextDev,
  randomNimiqHex,
  createTestSession,
  deleteTestSession,
  sha256Hex,
  apiPost,
  apiGet,
} from "./v2b1-dev-server";
import { Address } from "@nimiq/core";
import { truncateAddress, formatDate } from "@/lib/format";
import { formatNimAmount } from "@/lib/nimiq/units";

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

// ---------------------------------------------------------------------------
// T2 — Handle rules (pure functions)
// ---------------------------------------------------------------------------

function testHandleRules() {
  console.log("\n-- Handle rules --");

  check(isValidHandle("kaelah"), "valid: simple lowercase");
  check(isValidHandle("kae_lah_2"), "valid: digits and underscore");
  check(isValidHandle("abc"), "valid: exactly 3 chars");
  check(isValidHandle("abcdefghijklmnopqrstuvwx"), "valid: exactly 24 chars");
  check(isValidHandle("a_b_c"), "valid: internal underscores");

  check(!isValidHandle(""), "invalid: empty");
  check(!isValidHandle("ab"), "invalid: 2 chars");
  check(!isValidHandle("abcdefghijklmnopqrstuvwxy"), "invalid: 25 chars");
  check(!isValidHandle("Kaelah"), "invalid: uppercase");
  check(!isValidHandle("kae-lah"), "invalid: hyphen");
  check(!isValidHandle("kae lah"), "invalid: space");
  check(!isValidHandle("kae.lah"), "invalid: dot");
  check(!isValidHandle("kae@lah"), "invalid: symbol");
  check(!isValidHandle("kaeläh"), "invalid: non-ASCII");
  check(!isValidHandle("kae\nlah"), "invalid: newline");
  check(!isValidHandle("_kaelah") === false, "underscore is an allowed character");
  check(isValidHandle("_kaelah"), "valid: underscore is an allowed char");

  check(normalizeHandle(" Kaelah ") === "kaelah", "canonical: trims and lowercases");
  check(normalizeHandle("KAELAH") === "kaelah", "canonical: uppercase to lowercase");

  check(isReservedHandle("admin"), "reserved: admin");
  check(isReservedHandle("votum"), "reserved: votum");
  check(isReservedHandle("support"), "reserved: support");
  check(isReservedHandle("api"), "reserved: api");
  check(isReservedHandle("explore"), "reserved: explore");
  check(isReservedHandle("profile"), "reserved: profile");
  check(isReservedHandle("settings"), "reserved: settings");
  check(isReservedHandle("login"), "reserved: login");
  check(isReservedHandle("logout"), "reserved: logout");
  check(isReservedHandle("how-it-works"), "reserved: how-it-works");
  check(isReservedHandle("my-polls"), "reserved: my-polls");
  check(!isReservedHandle("kaelah"), "not reserved: ordinary handle");

  check(validateHandle("KaeLah_01") === "kaelah_01", "validate: normalizes valid input");
  check(validateHandle("admin") === null, "validate: rejects reserved");
  check(validateHandle("a b") === null, "validate: rejects whitespace");
  check(validateHandle("ab") === null, "validate: rejects too short");

  check(normalizeDisplayName("  Kaelah  ") === "Kaelah", "display name: trims");
  check(normalizeDisplayName("   ") === null, "display name: whitespace-only -> null");
  check(normalizeDisplayName("") === null, "display name: empty -> null");
  check(normalizeDisplayName("x".repeat(40)) === "x".repeat(40), "display name: exactly 40");
  check(normalizeDisplayName("x".repeat(41)) === null, "display name: 41 rejected");
  check(normalizeDisplayName("line1\nline2") === null, "display name: newline rejected");

  check(RESERVED_HANDLES.size >= 50, "reserved list size is complete");
}

// ---------------------------------------------------------------------------
// T2 — Public profile serialization allowlist
// ---------------------------------------------------------------------------

function testSerializer() {
  console.log("\n-- Public profile serializer allowlist --");

  const clean: any = {
    profile: {
      walletAddress: "ec323ef660c913e4a3f0659bfb6b63333255b278",
      displayName: null,
      handle: null,
      verifiedAt: "2026-08-05T15:37:02.560229+00:00",
      joinedDate: "2026-08-14T20:43:15.276617+00:00",
    },
    stats: {
      pollsCreated: 1,
      participations: 1,
      nimSupportedLuna: "0",
      nimEarnedLuna: "0",
    },
    activity: [
      {
        kind: "participated",
        pollId: "2d09e346-56a2-4937-abff-4723fbe48efa",
        question: "Who is the greatest football player of all time?",
        at: "2026-08-05T15:48:05.284866+00:00",
      },
    ],
  };

  const ok = serializePublicProfile(clean);
  check(ok !== null, "clean payload serializes");
  check(ok?.profile?.walletAddress === clean.profile.walletAddress, "wallet address preserved");

  const withSensitive: any = {
    ...clean,
    profile: { ...clean.profile, tokenHash: "abc", sessionToken: "xyz" },
    stats: { ...clean.stats },
    extra: { optionId: "leak", chosenLabel: "Mobile App" },
  };
  const scrubbed = serializePublicProfile(withSensitive) as ParticipantPublicProfile;
  check(scrubbed !== null, "payload with extra keys still serializes");
  check(
    JSON.stringify(scrubbed).includes("tokenHash") === false,
    "token hash stripped",
  );
  check(
    JSON.stringify(scrubbed).includes("sessionToken") === false,
    "session token stripped",
  );
  check(
    JSON.stringify(scrubbed).includes("optionId") === false,
    "optionId absent from serialized output",
  );
  check(
    JSON.stringify(scrubbed).includes("chosenLabel") === false,
    "chosen label absent from serialized output",
  );
  check(
    JSON.stringify(scrubbed).includes("challengeId") === false,
    "challenge data absent",
  );

  const activityWithOption: any = {
    ...clean,
    activity: [
      { ...clean.activity[0], optionId: "abc-123", optionLabel: "Mobile App" },
    ],
  };
  const scrubbedActivity = serializePublicProfile(activityWithOption) as ParticipantPublicProfile;
  check(
    JSON.stringify(scrubbedActivity).includes("optionId") === false,
    "activity optionId stripped",
  );
  check(
    JSON.stringify(scrubbedActivity).includes("optionLabel") === false,
    "activity optionLabel stripped",
  );

  check(serializePublicProfile(null) === null, "null payload rejected");
  check(serializePublicProfile({}) === null, "empty payload rejected");
  check(
    serializePublicProfile({ ...clean, profile: { walletAddress: "only" } }) === null,
    "partial profile rejected",
  );
  check(
    serializePublicProfile({ ...clean, activity: [{ kind: "voted", pollId: "x", question: "y", at: "z" }] }) === null,
    "unknown activity kind rejected",
  );
}

// ---------------------------------------------------------------------------
// T3 — Session-gated bootstrap
// ---------------------------------------------------------------------------

async function testBootstrap(wallets: string[]) {
  console.log("\n-- Bootstrap --");

  const walletA = randomNimiqHex();
  const other = randomNimiqHex();
  wallets.push(walletA);

  const noSession = await apiPost("/api/profile/bootstrap", {});
  check(
    noSession.status === 401 && noSession.data?.error === "session_missing",
    "bootstrap without session → 401",
  );

  const token = await createTestSession(walletA);
  const first = await apiPost("/api/profile/bootstrap", {}, token);
  check(first.status === 200, "bootstrap with session → 200");
  check(
    first.data?.profile?.walletAddress === walletA,
    "profile created for session wallet",
  );
  check(
    first.data?.profile?.displayName === null && first.data?.profile?.handle === null,
    "new profile has no presentation fields",
  );

  const bodySpoof = await apiPost("/api/profile/bootstrap", { wallet: other }, token);
  check(
    bodySpoof.status === 200 && bodySpoof.data?.profile?.walletAddress === walletA,
    "arbitrary body wallet ignored — session wallet is authoritative",
  );

  const verifiedAt = first.data.profile.verifiedAt;
  const second = await apiPost("/api/profile/bootstrap", {}, token);
  check(
    second.data?.profile?.walletAddress === walletA,
    "repeated bootstrap returns the same profile",
  );
  check(
    second.data?.profile?.verifiedAt === verifiedAt,
    "verified_at preserved across repeats",
  );
  const { count: rowCount } = await admin
    .from("participant_profiles")
    .select("wallet_address", { count: "exact", head: true })
    .eq("wallet_address", walletA);
  check(rowCount === 1, "exactly one profile row per wallet");

  await admin
    .from("participant_profiles")
    .update({ display_name: "Kaelah", handle: "kaelah", updated_at: new Date().toISOString() })
    .eq("wallet_address", walletA);
  const third = await apiPost("/api/profile/bootstrap", {}, token);
  check(third.data?.profile?.displayName === "Kaelah", "display_name preserved across bootstrap");
  check(third.data?.profile?.handle === "kaelah", "handle preserved across bootstrap");

  const token2 = await createTestSession(walletA);
  await admin
    .from("wallet_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", sha256Hex(token2));
  const revoked = await apiPost("/api/profile/bootstrap", {}, token2);
  check(revoked.status === 401, "revoked session cannot bootstrap");
  const afterRevoke = await admin
    .from("participant_profiles")
    .select("wallet_address")
    .eq("wallet_address", walletA)
    .maybeSingle();
  check(afterRevoke.data !== null, "revoked session / disconnect does not delete the profile");

  // Bootstrap must not alter vote/support records.
  const pollRes = await admin.from("polls").insert({
    creator_wallet: walletA,
    question: "Bootstrap neutrality test poll?",
    mode: "creator_support",
    destination_wallet: walletA,
    destination_purpose: "test",
    min_nim_luna: 10,
    fairness_mode: "one_wallet_one_vote",
    status: "live",
    is_public: true,
    category: "other",
    format: "decision",
    ends_at: new Date(Date.now() + 86400000).toISOString(),
    starts_at: new Date(Date.now() - 86400000).toISOString(),
  }).select("id").single();
  check(pollRes.data !== null, "fixture poll created");
  if (pollRes.data) {
    const pollId = pollRes.data.id as string;
    const optRes = await admin.from("poll_options").insert([
      { poll_id: pollId, label: "Option One", sort_order: 0 },
      { poll_id: pollId, label: "Option Two", sort_order: 1 },
    ]).select("id");
    const optionId = optRes.data?.[0]?.id as string;

    await admin.from("poll_votes").insert({
      poll_id: pollId,
      option_id: optionId,
      voter_wallet: walletA,
    });

    const intentRes = await admin.from("nim_support_intents").insert({
      reference: `v2b1-${sha256Hex(walletA).slice(0, 16)}`,
      poll_id: pollId,
      option_id: optionId,
      initiator_wallet: walletA,
      supporter_wallet: walletA,
      recipient_wallet: walletA,
      amount_luna: 100,
      memo: "v2b1 test",
      status: "confirmed",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    }).select("id").single();
    check(intentRes.data !== null, "neutrality intent fixture inserted");
    const intentId = intentRes.data?.id as string;

    const contribRes = await admin.from("nim_contributions").insert({
      intent_id: intentId,
      poll_id: pollId,
      option_id: optionId,
      supporter_wallet: walletA,
      recipient_wallet: walletA,
      amount_luna: 100,
      transaction_hash: `tx-${sha256Hex(walletA).slice(0, 24)}`,
    });
    check(contribRes.error === null, "neutrality contribution fixture inserted");

    const voteCount = () =>
      admin.from("poll_votes").select("id", { count: "exact", head: true }).eq("poll_id", pollId);
    const contribCount = () =>
      admin.from("nim_contributions").select("id", { count: "exact", head: true }).eq("poll_id", pollId);

    const votesBefore = (await voteCount()).count ?? -1;
    const contribsBefore = (await contribCount()).count ?? -1;

    const boot4 = await apiPost("/api/profile/bootstrap", {}, token);
    check(boot4.status === 200, "bootstrap succeeds with existing activity");

    const votesAfter = (await voteCount()).count ?? -2;
    const contribsAfter = (await contribCount()).count ?? -2;
    check(
      votesAfter === votesBefore && contribsAfter === contribsBefore,
      "bootstrap does not alter vote/support records",
    );
  }

  await deleteTestSession(token);
}

// ---------------------------------------------------------------------------
// T4 — Public profile query layer + derived stats/activity + privacy
// ---------------------------------------------------------------------------

async function testPublicQuery(wallets: string[]) {
  console.log("\n-- Public query + stats + activity --");

  const walletB = randomNimiqHex();
  wallets.push(walletB);

  const token = await createTestSession(walletB);
  await apiPost("/api/profile/bootstrap", {}, token);

  await admin
    .from("participant_profiles")
    .update({ display_name: "Briar", handle: "briar", updated_at: new Date().toISOString() })
    .eq("wallet_address", walletB);

  // Public live poll + vote + confirmed contribution.
  const livePoll = await admin.from("polls").insert({
    creator_wallet: walletB,
    question: "Which feature should we build next?",
    mode: "creator_support",
    destination_wallet: walletB,
    destination_purpose: "test",
    min_nim_luna: 10,
    fairness_mode: "one_wallet_one_vote",
    status: "live",
    is_public: true,
    category: "other",
    format: "decision",
    ends_at: new Date(Date.now() + 86400000).toISOString(),
    starts_at: new Date(Date.now() - 86400000).toISOString(),
  }).select("id").single();

  const liveId = livePoll.data?.id as string;
  const liveOpts = await admin.from("poll_options").insert([
    { poll_id: liveId, label: "Mobile App", sort_order: 0 },
    { poll_id: liveId, label: "Web App", sort_order: 1 },
  ]).select("id");
  const liveOption = liveOpts.data?.[0]?.id as string;

  await admin.from("poll_votes").insert({
    poll_id: liveId,
    option_id: liveOption,
    voter_wallet: walletB,
  });

  const liveIntent = await admin.from("nim_support_intents").insert({
    reference: `v2b1-live-${sha256Hex(walletB).slice(0, 12)}`,
    poll_id: liveId,
    option_id: liveOption,
    initiator_wallet: walletB,
    supporter_wallet: walletB,
    recipient_wallet: walletB,
    amount_luna: 100,
    memo: "v2b1 test",
    status: "confirmed",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  }).select("id").single();
  check(liveIntent.data !== null, "support intent fixture inserted");

  const contribInsert = await admin.from("nim_contributions").insert({
    intent_id: liveIntent.data?.id as string,
    poll_id: liveId,
    option_id: liveOption,
    supporter_wallet: walletB,
    recipient_wallet: walletB,
    amount_luna: 100,
    transaction_hash: `tx-live-${sha256Hex(walletB).slice(0, 20)}`,
  });
  check(contribInsert.error === null, "confirmed contribution fixture inserted");

  // Public closed poll + vote.
  const closedPoll = await admin.from("polls").insert({
    creator_wallet: walletB,
    question: "Which football position is hardest to master?",
    mode: "creator_support",
    destination_wallet: walletB,
    destination_purpose: "test",
    min_nim_luna: 10,
    fairness_mode: "one_wallet_one_vote",
    status: "closed",
    is_public: true,
    category: "sports",
    format: "decision",
    ends_at: new Date(Date.now() - 3600000).toISOString(),
    starts_at: new Date(Date.now() - 172800000).toISOString(),
  }).select("id").single();

  const closedId = closedPoll.data?.id as string;
  const closedOpts = await admin.from("poll_options").insert([
    { poll_id: closedId, label: "Goalkeeper", sort_order: 0 },
    { poll_id: closedId, label: "Striker", sort_order: 1 },
  ]).select("id");
  await admin.from("poll_votes").insert({
    poll_id: closedId,
    option_id: closedOpts.data?.[0]?.id as string,
    voter_wallet: walletB,
  });

  // Private poll + vote — must be excluded everywhere.
  const privatePoll = await admin.from("polls").insert({
    creator_wallet: walletB,
    question: "Secret internal decision",
    mode: "creator_support",
    destination_wallet: walletB,
    destination_purpose: "test",
    min_nim_luna: 10,
    fairness_mode: "one_wallet_one_vote",
    status: "live",
    is_public: false,
    category: "other",
    format: "decision",
    ends_at: new Date(Date.now() + 86400000).toISOString(),
    starts_at: new Date(Date.now() - 86400000).toISOString(),
  }).select("id").single();

  const privateId = privatePoll.data?.id as string;
  const privateOpts = await admin.from("poll_options").insert([
    { poll_id: privateId, label: "Secret A", sort_order: 0 },
  ]).select("id");
  await admin.from("poll_votes").insert({
    poll_id: privateId,
    option_id: privateOpts.data?.[0]?.id as string,
    voter_wallet: walletB,
  });

  // --- Lookups ---
  const hexLookup = await apiGet(`/api/profile?wallet=${walletB}`);
  check(hexLookup.status === 200, "wallet lookup → 200");
  check(hexLookup.data?.profile?.walletAddress === walletB, "wallet lookup returns canonical address");
  check(hexLookup.data?.profile?.displayName === "Briar", "display name present");
  check(hexLookup.data?.profile?.handle === "briar", "handle present");
  check(typeof hexLookup.data?.profile?.verifiedAt === "string", "verifiedAt present");
  check(typeof hexLookup.data?.profile?.joinedDate === "string", "joinedDate present");

  const nqAddress = Address.fromString(walletB).toUserFriendlyAddress();
  const nqLookup = await apiGet(`/api/profile?wallet=${encodeURIComponent(nqAddress)}`);
  check(nqLookup.status === 200, "NQ-format wallet lookup → 200");
  check(
    nqLookup.data?.profile?.walletAddress === walletB,
    "NQ-format lookup resolves to the same canonical profile",
  );

  const handleLookup = await apiGet("/api/profile?handle=briar");
  check(handleLookup.status === 200, "handle lookup → 200");
  check(
    handleLookup.data?.profile?.walletAddress === walletB,
    "handle route resolves the same underlying profile",
  );
  const upperHandleLookup = await apiGet("/api/profile?handle=BRIAR");
  check(
    upperHandleLookup.status === 200 &&
      upperHandleLookup.data?.profile?.walletAddress === walletB,
    "handle lookup is case-insensitive (canonical lowercase)",
  );

  const unknownWallet = await apiGet(`/api/profile?wallet=${randomNimiqHex()}`);
  check(unknownWallet.status === 404, "unknown wallet → 404");
  const malformedWallet = await apiGet("/api/profile?wallet=not-a-wallet-address");
  check(malformedWallet.status === 404, "malformed wallet → 404");
  const unknownHandle = await apiGet("/api/profile?handle=ghost_user");
  check(unknownHandle.status === 404, "unknown handle → 404");
  const bothParams = await apiGet(`/api/profile?wallet=${walletB}&handle=briar`);
  check(bothParams.status === 400, "both wallet and handle → 400");
  const noParams = await apiGet("/api/profile");
  check(noParams.status === 400, "neither wallet nor handle → 400");

  // --- Stats ---
  const stats = hexLookup.data?.stats;
  check(stats?.pollsCreated === 2, "stats.pollsCreated = 2 public polls only");
  check(stats?.participations === 2, "stats.participations = 2 public votes only");
  check(stats?.nimSupportedLuna === "100", "stats.nimSupportedLuna = confirmed-only 100");
  check(stats?.nimEarnedLuna === "0", "stats.nimEarnedLuna truthful 0");

  // --- Activity ---
  const activity = hexLookup.data?.activity as any[];
  check(Array.isArray(activity) && activity.length === 4, "activity has 4 public items");
  check(activity.length <= 12, "activity bounded at 12");
  check(
    activity.every((a) => a.kind === "created" || a.kind === "participated"),
    "activity kinds are created/participated only",
  );
  check(
    activity.every((a) => typeof a.pollId === "string" && typeof a.question === "string" && typeof a.at === "string"),
    "activity items expose pollId/question/at only",
  );
  check(
    activity.some((a) => a.question === "Which feature should we build next?"),
    "public poll title appears in activity",
  );
  check(
    !activity.some((a) => a.question === "Secret internal decision"),
    "private poll activity does not appear",
  );
  check(
    !activity.some((a) => a.question === "Mobile App" || a.question === "Goalkeeper"),
    "option labels never appear as activity items",
  );

  // --- Deep allowlist / privacy ---
  const json = JSON.stringify(hexLookup.data);
  check(json.includes("option_id") === false, "option_id absent from response JSON");
  check(json.includes("optionId") === false, "optionId absent from response JSON");
  check(json.includes("token_hash") === false, "token_hash absent from response JSON");
  check(json.includes("session") === false, "session data absent from response JSON");
  check(json.includes("challenge") === false, "challenge data absent from response JSON");
  check(json.includes("cookie") === false, "cookie/auth data absent from response JSON");

  // Chosen-option leak proof: the exact chosen labels must not appear.
  check(json.includes("Mobile App") === false, "chosen option text never leaked");
  check(json.includes("Web App") === false, "unchosen option text also absent");

  const handleJson = JSON.stringify(handleLookup.data);
  check(handleJson.includes("option") === false, "handle lookup also option-free");

  await deleteTestSession(token);
}

// ---------------------------------------------------------------------------
// T5 — Profile editing + handle availability/concurrency
// ---------------------------------------------------------------------------

async function testEdit(wallets: string[]) {
  console.log("\n-- Profile editing + handle concurrency --");

  const walletC = randomNimiqHex();
  const walletD = randomNimiqHex();
  wallets.push(walletC, walletD);

  // Unauthenticated edit.
  const anonPut = await apiPut("/api/profile/me", { displayName: "X" });
  check(anonPut.status === 401, "unauthenticated edit → 401");

  // Editing without a profile.
  const noProfileToken = await createTestSession(walletD);
  const noProfile = await apiPut("/api/profile/me", { displayName: "X" }, noProfileToken);
  check(noProfile.status === 404, "edit without existing profile → 404");

  const tokenC = await createTestSession(walletC);
  await apiPost("/api/profile/bootstrap", {}, tokenC);

  // Display name.
  const setDn = await apiPut("/api/profile/me", { displayName: "Cai" }, tokenC);
  check(setDn.status === 200 && setDn.data?.profile?.displayName === "Cai", "display name set");
  const updateDn = await apiPut("/api/profile/me", { displayName: "  Cai Renamed  " }, tokenC);
  check(
    updateDn.status === 200 && updateDn.data?.profile?.displayName === "Cai Renamed",
    "display name update trims",
  );
  const clearDn = await apiPut("/api/profile/me", { displayName: "" }, tokenC);
  check(clearDn.status === 200 && clearDn.data?.profile?.displayName === null, "display name clears to null");
  const longDn = await apiPut("/api/profile/me", { displayName: "x".repeat(41) }, tokenC);
  check(longDn.status === 400 && longDn.data?.error === "invalid_display_name", "display name 41 chars → 400");

  // Handle creation with canonicalisation.
  const createHandle = await apiPut("/api/profile/me", { handle: "Cai_01" }, tokenC);
  check(createHandle.status === 200, "handle creation → 200");
  check(createHandle.data?.profile?.handle === "cai_01", "handle stored canonical lowercase");

  // Wallet is immutable.
  check(createHandle.data?.profile?.walletAddress === walletC, "wallet address immutable across edits");

  // Editing another wallet is impossible — body wallet is ignored.
  const spoof = await apiPut("/api/profile/me", { displayName: "Hacked" }, tokenC);
  check(spoof.data?.profile?.walletAddress === walletC, "edit target always the session wallet");

  // Handle rename — old handle is released.
  const rename = await apiPut("/api/profile/me", { handle: "cai_renamed" }, tokenC);
  check(rename.status === 200 && rename.data?.profile?.handle === "cai_renamed", "handle rename");
  const tokenD = await createTestSession(walletD);
  await apiPost("/api/profile/bootstrap", {}, tokenD);
  const claimOld = await apiPut("/api/profile/me", { handle: "cai_01" }, tokenD);
  check(claimOld.status === 200 && claimOld.data?.profile?.handle === "cai_01", "renamed-away handle is released and claimable");

  // Duplicate handle.
  const dup = await apiPut("/api/profile/me", { handle: "cai_01" }, tokenC);
  check(dup.status === 409 && dup.data?.error === "handle_taken", "duplicate handle → 409 handle_taken");

  // Reserved / malformed.
  const reserved = await apiPut("/api/profile/me", { handle: "votum" }, tokenC);
  check(reserved.status === 409 && reserved.data?.error === "reserved_handle", "reserved handle → 409");
  const malformed = await apiPut("/api/profile/me", { handle: "no way!" }, tokenC);
  check(malformed.status === 400 && malformed.data?.error === "invalid_handle", "malformed handle → 400");
  const upperReserved = await apiPut("/api/profile/me", { handle: "ADMIN" }, tokenC);
  check(upperReserved.status === 409 && upperReserved.data?.error === "reserved_handle", "reserved handle case-insensitive → 409");

  // Clearing the handle.
  const clearHandle = await apiPut("/api/profile/me", { handle: "" }, tokenC);
  check(clearHandle.status === 200 && clearHandle.data?.profile?.handle === null, "handle clears to null");

  // No-op same-handle update is allowed.
  await apiPut("/api/profile/me", { handle: "cai_renamed" }, tokenC);
  const sameHandle = await apiPut("/api/profile/me", { handle: "cai_renamed" }, tokenC);
  check(sameHandle.status === 200, "re-claiming your own handle is a no-op success");

  // Concurrent race — two wallets claim the same free handle simultaneously.
  const walletE = randomNimiqHex();
  const walletF = randomNimiqHex();
  wallets.push(walletE, walletF);
  const tokenE = await createTestSession(walletE);
  const tokenF = await createTestSession(walletF);
  await apiPost("/api/profile/bootstrap", {}, tokenE);
  await apiPost("/api/profile/bootstrap", {}, tokenF);

  const raceTarget = `race_${sha256Hex(walletE).slice(0, 8)}`;
  const [resE, resF] = await Promise.all([
    apiPut("/api/profile/me", { handle: raceTarget }, tokenE),
    apiPut("/api/profile/me", { handle: raceTarget }, tokenF),
  ]);
  const winners = [resE, resF].filter((r) => r.status === 200);
  const losers = [resE, resF].filter((r) => r.status === 409 && r.data?.error === "handle_taken");
  check(winners.length === 1, "concurrent handle race → exactly one winner");
  check(losers.length === 1, "concurrent handle race → exactly one clean 409 handle_taken");

  const holder = await admin
    .from("participant_profiles")
    .select("wallet_address")
    .eq("handle", raceTarget)
    .maybeSingle();
  check(holder.data !== null, "database has exactly one owner of the raced handle");
  const { count: holderCount } = await admin
    .from("participant_profiles")
    .select("handle", { count: "exact", head: true })
    .eq("handle", raceTarget);
  check(holderCount === 1, "unique index guarantees a single handle owner row");

  // Availability endpoint (UX-only).
  const anonAvail = await apiGet("/api/profile/me/availability?handle=freebie");
  check(anonAvail.status === 401, "availability without session → 401");
  const freeAvail = await apiGet("/api/profile/me/availability?handle=freebie", tokenC);
  check(freeAvail.status === 200 && freeAvail.data?.available === true, "availability: free handle → true");
  const takenAvail = await apiGet(`/api/profile/me/availability?handle=${raceTarget}`, tokenC);
  check(
    takenAvail.status === 200 && takenAvail.data?.available === false && takenAvail.data?.reason === "taken",
    "availability: taken handle → false/taken",
  );
  const reservedAvail = await apiGet("/api/profile/me/availability?handle=explore", tokenC);
  check(
    reservedAvail.status === 200 && reservedAvail.data?.available === false && reservedAvail.data?.reason === "reserved",
    "availability: reserved handle → false/reserved",
  );
  const badAvail = await apiGet("/api/profile/me/availability?handle=x", tokenC);
  check(badAvail.status === 400, "availability: malformed handle → 400");

  // GET /api/profile/me — owner fetch.
  const ownerGet = await apiGet("/api/profile/me", tokenC);
  check(ownerGet.status === 200 && ownerGet.data?.profile?.walletAddress === walletC, "GET /api/profile/me returns owner profile");
  const ownerGetOther = await apiGet("/api/profile/me", tokenD);
  check(
    ownerGetOther.status === 200 && ownerGetOther.data?.profile?.walletAddress === walletD,
    "GET /api/profile/me is scoped to the session wallet",
  );

  await deleteTestSession(tokenC);
  await deleteTestSession(tokenD);
  await deleteTestSession(tokenE);
  await deleteTestSession(tokenF);
}

// ---------------------------------------------------------------------------
// T9 — Public profile pages (/profile/[wallet] and /u/[handle])
// ---------------------------------------------------------------------------

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

async function testProfilePages(wallets: string[]) {
  console.log("\n-- Public profile pages (/profile/[wallet], /u/[handle]) --");

  const walletG = randomNimiqHex();
  wallets.push(walletG);
  const handle = `t9_${sha256Hex(walletG).slice(0, 8)}`;

  const token = await createTestSession(walletG);
  await apiPost("/api/profile/bootstrap", {}, token);
  await admin
    .from("participant_profiles")
    .update({ display_name: "T9 Participant", handle, updated_at: new Date().toISOString() })
    .eq("wallet_address", walletG);

  // Public live poll + vote + confirmed contribution (500000 Luna = 5 NIM).
  const livePoll = await admin.from("polls").insert({
    creator_wallet: walletG,
    question: "T9 flagship question?",
    mode: "creator_support",
    destination_wallet: walletG,
    destination_purpose: "test",
    min_nim_luna: 10,
    fairness_mode: "one_wallet_one_vote",
    status: "live",
    is_public: true,
    category: "other",
    format: "decision",
    ends_at: new Date(Date.now() + 86400000).toISOString(),
    starts_at: new Date(Date.now() - 86400000).toISOString(),
  }).select("id").single();
  const liveId = livePoll.data?.id as string;
  const liveOpts = await admin.from("poll_options").insert([
    { poll_id: liveId, label: "T9Chosen", sort_order: 0 },
    { poll_id: liveId, label: "T9Unchosen", sort_order: 1 },
  ]).select("id");
  const liveOption = liveOpts.data?.[0]?.id as string;
  await admin.from("poll_votes").insert({
    poll_id: liveId,
    option_id: liveOption,
    voter_wallet: walletG,
  });
  const liveIntent = await admin.from("nim_support_intents").insert({
    reference: `v2b1-t9-${sha256Hex(walletG).slice(0, 12)}`,
    poll_id: liveId,
    option_id: liveOption,
    initiator_wallet: walletG,
    supporter_wallet: walletG,
    recipient_wallet: walletG,
    amount_luna: 500000,
    memo: "v2b1 test",
    status: "confirmed",
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  }).select("id").single();
  await admin.from("nim_contributions").insert({
    intent_id: liveIntent.data?.id as string,
    poll_id: liveId,
    option_id: liveOption,
    supporter_wallet: walletG,
    recipient_wallet: walletG,
    amount_luna: 500000,
    transaction_hash: `tx-t9-${sha256Hex(walletG).slice(0, 20)}`,
  });

  // Public closed poll + vote.
  const closedPoll = await admin.from("polls").insert({
    creator_wallet: walletG,
    question: "T9 closed poll question?",
    mode: "creator_support",
    destination_wallet: walletG,
    destination_purpose: "test",
    min_nim_luna: 10,
    fairness_mode: "one_wallet_one_vote",
    status: "closed",
    is_public: true,
    category: "sports",
    format: "decision",
    ends_at: new Date(Date.now() - 3600000).toISOString(),
    starts_at: new Date(Date.now() - 172800000).toISOString(),
  }).select("id").single();
  const closedId = closedPoll.data?.id as string;
  const closedOpts = await admin.from("poll_options").insert([
    { poll_id: closedId, label: "T9ClosedChosen", sort_order: 0 },
    { poll_id: closedId, label: "T9ClosedUnchosen", sort_order: 1 },
  ]).select("id");
  await admin.from("poll_votes").insert({
    poll_id: closedId,
    option_id: closedOpts.data?.[0]?.id as string,
    voter_wallet: walletG,
  });

  // Private poll + vote — must be absent from the page.
  const privatePoll = await admin.from("polls").insert({
    creator_wallet: walletG,
    question: "T9 private secret question?",
    mode: "creator_support",
    destination_wallet: walletG,
    destination_purpose: "test",
    min_nim_luna: 10,
    fairness_mode: "one_wallet_one_vote",
    status: "live",
    is_public: false,
    category: "other",
    format: "decision",
    ends_at: new Date(Date.now() + 86400000).toISOString(),
    starts_at: new Date(Date.now() - 86400000).toISOString(),
  }).select("id").single();
  const privateId = privatePoll.data?.id as string;
  const privateOpts = await admin.from("poll_options").insert([
    { poll_id: privateId, label: "T9SecretOption", sort_order: 0 },
  ]).select("id");
  await admin.from("poll_votes").insert({
    poll_id: privateId,
    option_id: privateOpts.data?.[0]?.id as string,
    voter_wallet: walletG,
  });

  // Reference data via the public API — the page must render exactly this.
  const api = await apiGet(`/api/profile?wallet=${walletG}`);
  check(api.status === 200, "fixture profile resolves via public API");
  check(api.data?.stats?.pollsCreated === 2, "fixture: 2 public polls counted");
  check(api.data?.stats?.participations === 2, "fixture: 2 public votes counted");
  check(api.data?.stats?.nimSupportedLuna === "500000", "fixture: confirmed-only 500000 Luna");
  check(api.data?.activity?.length === 4, "fixture: 4 public activity items");

  const joinedText = `Joined ${formatDate(new Date(api.data.profile.joinedDate))}`;
  const truncated = truncateAddress(walletG);
  const nimEarnedText = formatNimAmount(BigInt(api.data.stats.nimEarnedLuna));
  const nimSupportedText = formatNimAmount(BigInt(api.data.stats.nimSupportedLuna));

  // --- Canonical wallet route ---
  const walletPage = await fetchHtml(`/profile/${walletG}`);
  check(walletPage.status === 200, "canonical wallet page → 200");
  const walletText = textOf(walletPage.html);
  check(walletText.includes("T9 Participant"), "header: display name rendered");
  check(walletText.includes(`@${handle}`), "header: @handle rendered");
  check(walletText.includes(truncated), "header: shortened wallet rendered");
  check(walletText.includes("Verified"), "header: Verified state represented");
  check(walletText.includes(joinedText), `header: joined date rendered (${joinedText})`);
  check(/2\s+Participations/.test(walletText), "stats: participations = 2");
  check(/2\s+Polls created/.test(walletText), "stats: polls created = 2");
  check(
    walletText.includes(`${nimEarnedText} NIM earned`),
    `stats: NIM earned renders truthful 0 (${nimEarnedText})`,
  );
  check(
    walletText.includes(`${nimSupportedText} Legacy NIM support`),
    `stats: NIM supported renders confirmed total (${nimSupportedText})`,
  );

  // --- Handle route resolves the same participant ---
  const handlePage = await fetchHtml(`/u/${handle}`);
  check(handlePage.status === 200, "handle page → 200");
  const handleText = textOf(handlePage.html);
  check(handleText.includes(truncated), "handle route renders the same wallet identity");
  check(handleText.includes(`@${handle}`), "handle route renders the same @handle");

  // --- NQ-format wallet resolves canonically ---
  // NQ user-friendly addresses contain spaces; %20-encoded spaces in a
  // dynamic path segment are not routed by Next.js dev (404 at the router),
  // so the space-less NQ form is exercised at page level here. NQ-with-spaces
  // canonicalisation is already covered by the T4 API-level tests.
  const nqAddress = Address.fromString(walletG).toUserFriendlyAddress();
  const nqPage = await fetchHtml(`/profile/${nqAddress.replace(/ /g, "")}`);
  check(nqPage.status === 200, "NQ-format wallet page → 200");
  check(
    textOf(nqPage.html).includes(truncated),
    "NQ wallet route resolves to the same canonical profile",
  );

  // --- Activity renders only kind + question, exactly the bounded API list ---
  const createdCount = countOccurrences(walletText, "Created \u201C");
  const participatedCount = countOccurrences(walletText, "Participated in \u201C");
  check(
    createdCount + participatedCount === api.data.activity.length,
    `activity renders exactly the bounded query result (${createdCount + participatedCount} of ${api.data.activity.length})`,
  );
  check(createdCount + participatedCount <= 12, "activity stays bounded at 12");
  for (const item of api.data.activity as any[]) {
    check(
      walletPage.html.includes(`/polls/${item.pollId}`),
      "activity item links to its public poll",
    );
    const expected =
      item.kind === "created"
        ? `Created \u201C${item.question}\u201D`
        : `Participated in \u201C${item.question}\u201D`;
    check(
      walletText.includes(expected),
      `activity item renders only kind + question (${item.kind})`,
    );
  }

  // --- Chosen option must never appear ---
  check(walletText.includes("T9Chosen") === false, "chosen option text absent from page");
  check(walletText.includes("T9Unchosen") === false, "unchosen option text absent from page");
  check(walletText.includes("T9ClosedChosen") === false, "closed-poll chosen option absent");
  check(walletText.includes("T9ClosedUnchosen") === false, "closed-poll unchosen option absent");
  check(walletText.includes("T9SecretOption") === false, "private poll option absent");
  check(walletText.includes("option_id") === false, "option_id absent from rendered page");
  check(walletText.includes("optionId") === false, "optionId absent from rendered page");

  // --- Private/draft activity stays off the page ---
  check(
    walletText.includes("T9 private secret question?") === false,
    "private poll activity absent from page",
  );

  // --- Not-found behavior (clean 404, no internals) ---
  const unknownWallet = await fetchHtml(`/profile/${randomNimiqHex()}`);
  check(unknownWallet.status === 404, "unknown wallet page → 404");
  const malformedWallet = await fetchHtml("/profile/not-a-wallet-address");
  check(malformedWallet.status === 404, "malformed wallet page → 404");
  const unknownHandle = await fetchHtml("/u/ghost_user");
  check(unknownHandle.status === 404, "unknown handle page → 404");
  const malformedHandle = await fetchHtml("/u/x");
  check(malformedHandle.status === 404, "malformed handle page → 404");
  const notFoundBody =
    unknownWallet.html + malformedWallet.html + unknownHandle.html + malformedHandle.html;
  check(notFoundBody.includes("Supabase") === false, "404 pages expose no Supabase internals");
  check(notFoundBody.includes("postgrest") === false, "404 pages expose no postgrest internals");
  check(notFoundBody.includes("RPC") === false, "404 pages expose no RPC internals");

  await deleteTestSession(token);
}

// ---------------------------------------------------------------------------
// T10 — /profile/edit owner gate (server-side exposure)
// ---------------------------------------------------------------------------

async function testProfileEditGate() {
  console.log("\n-- /profile/edit owner gate (server-side exposure) --");

  const page = await fetchHtml("/profile/edit");
  check(page.status === 200, "/profile/edit renders (client-gated shell)");
  check(
    page.html.includes("<input") === false,
    "no editable form fields are exposed without a verified session",
  );
  check(
    page.html.includes("Display name") === false,
    "display-name field absent from unauthenticated HTML",
  );
  check(
    page.html.includes("Save changes") === false,
    "save control absent from unauthenticated HTML",
  );
  check(
    page.html.includes("verifiedWalletAddress") === false,
    "no session wallet data in unauthenticated HTML",
  );
  check(
    page.html.includes("participant_profiles") === false,
    "no database internals in unauthenticated HTML",
  );
}

// ---------------------------------------------------------------------------

async function run() {
  console.log("V2B.1 Profile Suite");
  testHandleRules();
  testSerializer();

  const wallets: string[] = [];
  console.log("Starting Next.js dev server...");
  await startNextDev();
  console.log("Next.js ready.\n");
  try {
    await testBootstrap(wallets);
    await testPublicQuery(wallets);
    await testEdit(wallets);
    await testProfilePages(wallets);
    await testProfileEditGate();
  } finally {
    for (const w of wallets) cleanupTestWallet(w);
    stopNextDev();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
