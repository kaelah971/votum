/**
 * V2B.1 — Profile contract, handle-rule, bootstrap, query, and edit tests.
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
  } finally {
    for (const w of wallets) cleanupTestWallet(w);
    stopNextDev();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
