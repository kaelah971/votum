/**
 * NIM support sender-mismatch diagnostic.
 * Run: node --env-file=.env.local --import tsx src/lib/nimiq/support-diag.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Address } from "@nimiq/core";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SECRET_KEY!;
const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, db: { schema: "public" } });

function canonicalize(raw: string): string | null {
  try { return Address.fromString(raw.trim()).toHex(); } catch { return null; }
}
function fp(raw: string): string {
  return createHash("sha256").update(canonicalize(raw) ?? raw).digest("hex").slice(0, 10);
}

async function fetchTx(hash: string): Promise<any> {
  const rpc = process.env.NIMIQ_RPC_URL!;
  const res = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "getTransactionByHash", params: [hash], id: 1 }) });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result?.data ?? json.result;
}

async function main() {
  const { data: intents } = await (admin as any).from("nim_support_intents").select("*").eq("status", "submitted").not("submitted_transaction_hash", "is", null).order("created_at", { ascending: false }).limit(1);
  if (!intents?.length) { console.log("No submitted intents found."); process.exit(0); }
  const i = intents[0];

  const sCanon = canonicalize(i.supporter_wallet);
  const rCanon = canonicalize(i.recipient_wallet);
  console.log("Intent supporter canonical:", sCanon ? `OK (fp: ${fp(i.supporter_wallet)})` : "FAILED");
  console.log("Intent recipient canonical:", rCanon ? "OK" : "FAILED");

  console.log("\nFetching tx:", (i.submitted_transaction_hash as string).slice(0, 12) + "...");
  const tx = await fetchTx(i.submitted_transaction_hash);
  if (tx.error) { console.log("RPC error:", tx.error, tx.message); process.exit(0); }

  const txFrom = canonicalize(tx.from);
  const txTo = canonicalize(tx.to);
  console.log("RPC from canonical:", txFrom ? `OK (fp: ${fp(tx.from)})` : "FAILED");
  console.log("RPC to canonical:", txTo ? "OK" : "FAILED");

  console.log("\n=== MATCH ===");
  if (!txFrom) { console.log("BUG: normalizeAddress returns null for RPC sender → ?? fallback breaks comparison"); }
  else {
    const match = i.supporter_wallet === txFrom;
    console.log("Sender match:", match ? "YES" : "NO — genuinely different wallet");
    if (!match) { console.log(`  Supporter fp: ${fp(i.supporter_wallet)}  RPC from fp: ${fp(tx.from)}`); }
  }
  console.log("Recipient match:", i.recipient_wallet === txTo ? "YES" : "NO");
  console.log("Amount:", tx.value, "(Luna)");
  console.log("Execution:", tx.executionResult);

  // Attempt recovery with the new function
  console.log("\n=== RECOVERY ATTEMPT ===");
  if (txFrom && i.recipient_wallet === txTo) {
    const { data: recResult, error: recErr } = await (admin as any).rpc("confirm_nim_contribution_atomic", {
      _intent_id: i.id,
      _transaction_hash: i.submitted_transaction_hash,
      _block_number: typeof tx.blockNumber === "number" ? tx.blockNumber : null,
      _transaction_ts: typeof tx.timestamp === "number" ? new Date(tx.timestamp).toISOString() : null,
      _tx_sender: txFrom,
    });
    if (recErr) console.log("Recovery failed:", recErr.code, recErr.message);
    else console.log("Recovery result:", JSON.stringify(recResult));
  }
}

main().catch((e: any) => { console.error("FATAL:", e.message); process.exit(1); });
