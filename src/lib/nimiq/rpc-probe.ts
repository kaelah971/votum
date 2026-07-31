/**
 * Nimiq PoS RPC diagnostic probe (server-only).
 *
 * Queries a known transaction hash to inspect the actual response shape.
 * Reports only field presence and types — never prints sender, recipient,
 * memo, proof, raw transaction data, or environment values.
 *
 * Usage: node --env-file=.env.local --import tsx src/lib/nimiq/rpc-probe.ts <tx-hash>
 */

import { getTransactionByHash } from "@/lib/nimiq/rpc";

async function main() {
  const hash = process.argv[2];
  if (!hash) { console.error("Usage: npx tsx src/lib/nimiq/rpc-probe.ts <tx-hash>"); process.exit(1); }

  console.log("Probing:", hash.slice(0, 12) + "...");
  const result = await getTransactionByHash(hash);

  if ("error" in result) {
    console.log("RPC result: error:", result.error, result.message);
    process.exit(0);
  }

  const tx = result.data;
  console.log("Fields present:");
  console.log("  sender:", typeof tx.sender, tx.sender ? `(${tx.sender.slice(0, 8)}...)` : "MISSING");
  console.log("  recipient:", typeof tx.recipient, tx.recipient ? `(${tx.recipient.slice(0, 8)}...)` : "MISSING");
  console.log("  valueLuna:", typeof tx.valueLuna, tx.valueLuna);
  console.log("  recipientData:", typeof tx.recipientData, tx.recipientData ? `length=${tx.recipientData.length}, hex=${/^[0-9a-f]+$/.test(tx.recipientData)}, hexLen=${tx.recipientData.length % 2 === 0}` : "MISSING");
  console.log("  executionResult:", tx.executionResult);
  console.log("  networkId:", tx.networkId);
  console.log("  blockHeight:", tx.blockHeight);
  console.log("  timestampMs:", tx.timestampMs);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
