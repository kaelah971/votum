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

async function run() {
  console.log("V2B.1 Profile Suite");
  testHandleRules();
  testSerializer();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
