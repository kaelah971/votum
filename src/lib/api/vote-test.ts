/**
 * Vote hardening test script.
 *
 * Usage: node --env-file=.env.local --import tsx src/lib/api/vote-test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createClient } from "@supabase/supabase-js";
import { randomBytes, createHash } from "node:crypto";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SECRET_KEY!;
const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, db: { schema: "public" } });
const pubKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const pubClient = createClient(url, pubKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, db: { schema: "public" } });

const voterA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const voterB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const voterC = "cccccccccccccccccccccccccccccccccccccccc";

function uuid() { return randomBytes(16).toString("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5"); }
function fp(q: string, opts: string[]) { return createHash("sha256").update(JSON.stringify({ question: q, description: null, options: opts, mode: "creator_support", destinationWallet: voterA, destinationPurpose: "test", minimumNimLuna: "100000", fairnessMode: "one_wallet_one_vote", duration: "7days" }, Object.keys({ question: 1, description: 1, options: 1, mode: 1, destinationWallet: 1, destinationPurpose: 1, minimumNimLuna: 1, fairnessMode: 1, duration: 1 }).sort())).digest("hex"); }

async function publishPoll(q: string, opts: string[]) {
  const r = await admin.rpc("publish_poll_atomic", { _creator_wallet: voterA, _question: q, _description: null, _mode: "creator_support", _destination_wallet: voterA, _destination_purpose: "test", _min_nim_luna: 100000, _fairness_mode: "one_wallet_one_vote", _ends_at: new Date(Date.now() + 86400000).toISOString(), _options: opts, _idempotency_key: uuid(), _request_fingerprint: fp(q, opts) });
  if (r.error) throw r.error;
  return (r.data as any).id as string;
}

async function getOptions(pollId: string) { const { data } = await admin.from("poll_options").select("id,label").eq("poll_id", pollId).order("sort_order"); return data ?? []; }

function assert(cond: boolean, msg: string) { if (!cond) { console.error("FAIL:", msg); process.exit(1); } }

async function main() {
  const pollId = await publishPoll("Vote hardening test?", ["Alpha", "Beta"]);
  const opts = await getOptions(pollId);
  const [optA, optB] = opts;

  console.log("─── Test 1: First vote ───");
  const r1 = await admin.rpc("cast_poll_vote_atomic", { _poll_id: pollId, _option_id: optA.id, _voter_wallet: voterA });
  assert(r1.data && (r1.data as any).result_kind === "created", "Vote not created"); console.log("  PASS");

  console.log("─── Test 2: Same-option replay ───");
  const r2 = await admin.rpc("cast_poll_vote_atomic", { _poll_id: pollId, _option_id: optA.id, _voter_wallet: voterA });
  assert((r2.data as any).result_kind === "replay", "Not replay"); assert((r2.data as any).vote_id === (r1.data as any).vote_id, "Different vote ID on replay"); console.log("  PASS (same vote ID)");

  console.log("─── Test 3: Different-option → already_voted ───");
  const r3 = await admin.rpc("cast_poll_vote_atomic", { _poll_id: pollId, _option_id: optB.id, _voter_wallet: voterA });
  assert((r3.data as any).result_kind === "already_voted", "Not already_voted"); console.log("  PASS");

  console.log("─── Test 4: Different wallet ───");
  const r4 = await admin.rpc("cast_poll_vote_atomic", { _poll_id: pollId, _option_id: optB.id, _voter_wallet: voterB });
  assert((r4.data as any).result_kind === "created", "Voter B not created"); console.log("  PASS");

  console.log("─── Test 5: Concurrent identical votes (3x) ───");
  const poll2 = await publishPoll("Concurrent test?", ["X", "Y"]);
  const opts2 = await getOptions(poll2);
  const results = await Promise.all([admin.rpc("cast_poll_vote_atomic", { _poll_id: poll2, _option_id: opts2[0].id, _voter_wallet: voterC }), admin.rpc("cast_poll_vote_atomic", { _poll_id: poll2, _option_id: opts2[0].id, _voter_wallet: voterC }), admin.rpc("cast_poll_vote_atomic", { _poll_id: poll2, _option_id: opts2[0].id, _voter_wallet: voterC })]);
  const created = results.filter((r: any) => r.data?.result_kind === "created"); const replays = results.filter((r: any) => r.data?.result_kind === "replay");
  assert(created.length === 1, `Expected 1 created, got ${created.length}`); assert(replays.length === 2, `Expected 2 replays, got ${replays.length}`);
  const vid = (created[0].data as any).vote_id; assert(replays.every((r: any) => r.data.vote_id === vid), "Replays have different vote IDs");
  console.log("  PASS (1 created, 2 replays, same vote ID)");

  console.log("─── Test 6: Concurrent different options → one wins ───");
  const poll3 = await publishPoll("Concurrent diff test?", ["P", "Q"]); const opts3 = await getOptions(poll3);
  const diffResults = await Promise.all([admin.rpc("cast_poll_vote_atomic", { _poll_id: poll3, _option_id: opts3[0].id, _voter_wallet: voterC }), admin.rpc("cast_poll_vote_atomic", { _poll_id: poll3, _option_id: opts3[1].id, _voter_wallet: voterC })]);
  const created2 = diffResults.filter((r: any) => r.data?.result_kind === "created"); const conflicts = diffResults.filter((r: any) => r.data?.result_kind === "already_voted");
  assert(created2.length === 1 && conflicts.length === 1, "Concurrent diff option failed");
  const { data: votes3 } = await admin.from("poll_votes").select("id").eq("poll_id", poll3).eq("voter_wallet", voterC);
  assert((votes3 ?? []).length === 1, `Expected 1 vote row, got ${(votes3 ?? []).length}`); console.log("  PASS");

  console.log("─── Test 7: Different wallets concurrently ───");
  const poll3b = await publishPoll("Multi-wallet concurrent?", ["R", "S"]); const opts3b = await getOptions(poll3b);
  const multiResults = await Promise.all([admin.rpc("cast_poll_vote_atomic", { _poll_id: poll3b, _option_id: opts3b[0].id, _voter_wallet: voterA }), admin.rpc("cast_poll_vote_atomic", { _poll_id: poll3b, _option_id: opts3b[0].id, _voter_wallet: voterB })]);
  assert(multiResults.every((r: any) => r.data?.result_kind === "created"), "Not all votes created"); console.log("  PASS");

  console.log("─── Test 8: Missing poll ───");
  const r8 = await admin.rpc("cast_poll_vote_atomic", { _poll_id: "00000000-0000-0000-0000-000000000000", _option_id: optA.id, _voter_wallet: voterA });
  assert((r8.data as any).result_kind === "poll_not_found", "Should be poll_not_found"); console.log("  PASS");

  console.log("─── Test 9: Invalid option ───");
  const r9 = await admin.rpc("cast_poll_vote_atomic", { _poll_id: pollId, _option_id: opts3[0].id, _voter_wallet: voterA });
  assert((r9.data as any).result_kind === "invalid_option", "Should be invalid_option"); console.log("  PASS");

  console.log("─── Test 10: Public results ───");
  const { data: resData } = await pubClient.rpc("get_public_poll_results", { _poll_id: pollId });
  assert((resData as any).totalVotes === 2, `Expected 2 total votes`); console.log("  PASS");

  console.log("─── Test 11: No wallet leak ───");
  assert(!JSON.stringify(resData).includes(voterA) && !JSON.stringify(resData).includes(voterB), "Wallet leaked"); console.log("  PASS");

  console.log("─── Test 12: Option order ───");
  const ropts = (resData as any).options as any[];
  assert(ropts[0].optionId === optA.id && ropts[1].voteCount === 1, "Count wrong"); console.log("  PASS");

  console.log("─── Test 13: Replay doesn't increase totals ───");
  const { data: rb } = await pubClient.rpc("get_public_poll_results", { _poll_id: pollId });
  await admin.rpc("cast_poll_vote_atomic", { _poll_id: pollId, _option_id: optA.id, _voter_wallet: voterA });
  const { data: ra } = await pubClient.rpc("get_public_poll_results", { _poll_id: pollId });
  assert((rb as any).totalVotes === (ra as any).totalVotes, "Replay increased totals"); console.log("  PASS");

  console.log("\n═══ All 13 vote tests passed ═══");
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
