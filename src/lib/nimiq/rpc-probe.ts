/**
 * Nimiq PoS RPC diagnostic probe (server-only).
 *
 * Two modes:
 * 1. Probe a known hash:
 *    node --env-file=.env.local --import tsx src/lib/nimiq/rpc-probe.ts <tx-hash>
 *
 * 2. Discover mode — scan recent blocks for a tx with non-empty recipientData:
 *    node --env-file=.env.local --import tsx src/lib/nimiq/rpc-probe.ts --discover
 *
 * Reports only safe structural information — never prints sender, recipient,
 * memo, proof, raw transaction data, or environment values.
 */

const RPC_URL = process.env.NIMIQ_RPC_URL;

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

async function rpcCall(method: string, params: unknown[]): Promise<JsonRpcResponse> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(RPC_URL!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<JsonRpcResponse>;
  } finally {
    clearTimeout(t);
  }
}

/** Nimiq PoS wraps scalar results in result.data too. Unwrap when present. */
function unwrapResult(resp: JsonRpcResponse): unknown {
  if (resp.error) throw new Error(resp.error.message);
  const r = resp.result;
  if (r && typeof r === "object" && "data" in r) {
    return (r as Record<string, unknown>).data;
  }
  return r;
}

async function getBlockNumber(): Promise<number> {
  const resp = await rpcCall("getBlockNumber", []);
  const val = unwrapResult(resp);
  if (typeof val !== "number") throw new Error(`Unexpected blockNumber type: ${typeof val}`);
  return val;
}

async function getBlockTransactions(blockNumber: number): Promise<unknown[]> {
  const resp = await rpcCall("getBlockByNumber", [blockNumber, true]);
  const block = unwrapResult(resp) as Record<string, unknown> | undefined;
  if (!block || typeof block !== "object") return [];
  const txs = block.transactions;
  if (!Array.isArray(txs)) return [];
  return txs;
}

// ── Safe analysis ──────────────────────────────────────────────────────

interface ProbeReport {
  rpcReachable: boolean;
  blocksScanned: number;
  foundNonEmptyRecipientData: boolean;
  transactionShape: "flat" | "nested_data" | "unknown";
  nestedFieldName: string | null;
  hashFieldPresent: boolean;
  hashFieldType: string | null;
  recipientDataPresent: boolean;
  recipientDataType: string | null;
  recipientDataLength: number | null;
  recipientDataMatchesLowerHex: boolean;
  recipientDataHasEvenHexLength: boolean;
  recipientDataDecodesUtf8: boolean;
  networkIdPresent: boolean;
  networkIdType: string | null;
  networkIdValue: number | null;
  executionResultPresent: boolean;
  executionResultType: string | null;
  executionResultLocation: string;
  blockHeightField: string | null;
  timestampPresent: boolean;
  timestampType: string | null;
  timestampAppearsMilliseconds: boolean;
}

function inspect(raw: unknown): ProbeReport {
  const report: ProbeReport = {
    rpcReachable: true,
    blocksScanned: 0,
    foundNonEmptyRecipientData: false,
    transactionShape: "unknown",
    nestedFieldName: null,
    hashFieldPresent: false,
    hashFieldType: null,
    recipientDataPresent: false,
    recipientDataType: null,
    recipientDataLength: null,
    recipientDataMatchesLowerHex: false,
    recipientDataHasEvenHexLength: false,
    recipientDataDecodesUtf8: false,
    networkIdPresent: false,
    networkIdType: null,
    networkIdValue: null,
    executionResultPresent: false,
    executionResultType: null,
    executionResultLocation: "not_found",
    blockHeightField: null,
    timestampPresent: false,
    timestampType: null,
    timestampAppearsMilliseconds: false,
  };

  if (!raw || typeof raw !== "object") return report;

  const obj = raw as Record<string, unknown>;

  // Check for result.data envelope
  const data = obj.data;
  const tx = (data && typeof data === "object" ? data : obj) as Record<string, unknown>;

  if (data && typeof data === "object") {
    report.transactionShape = "nested_data";
    report.nestedFieldName = "data";
  } else if (typeof obj.hash === "string") {
    report.transactionShape = "flat";
  }

  // Hash
  report.hashFieldPresent = typeof tx.hash === "string";
  report.hashFieldType = typeof tx.hash;

  // recipientData
  const rd = tx.recipientData;
  if (rd !== undefined && rd !== null) {
    report.recipientDataPresent = true;
    report.recipientDataType = typeof rd;
    if (typeof rd === "string") {
      report.foundNonEmptyRecipientData = rd.length > 0;
      report.recipientDataLength = rd.length;
      report.recipientDataMatchesLowerHex = /^[0-9a-f]+$/.test(rd);
      report.recipientDataHasEvenHexLength = rd.length % 2 === 0;

      if (report.recipientDataMatchesLowerHex && report.recipientDataHasEvenHexLength) {
        try {
          const bytes = Buffer.from(rd, "hex");
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          report.recipientDataDecodesUtf8 = true;
        } catch { /* invalid */ }
      }
    }
  }

  // networkId
  report.networkIdPresent = tx.networkId !== undefined;
  report.networkIdType = typeof tx.networkId;
  if (typeof tx.networkId === "number") report.networkIdValue = tx.networkId;

  // executionResult — check both top-level and nested
  if (typeof tx.executionResult !== "undefined") {
    report.executionResultPresent = true;
    report.executionResultType = typeof tx.executionResult;
    report.executionResultLocation = "tx.executionResult";
  } else if (data && typeof data === "object" && typeof (data as Record<string, unknown>).executionResult !== "undefined") {
    report.executionResultPresent = true;
    report.executionResultType = typeof (data as Record<string, unknown>).executionResult;
    report.executionResultLocation = "result.data.executionResult";
  }

  // Block height
  if (typeof tx.blockNumber === "number") report.blockHeightField = "blockNumber";
  else if (typeof tx.blockHeight === "number") report.blockHeightField = "blockHeight";
  else if (typeof tx.height === "number") report.blockHeightField = "height";

  // Timestamp
  report.timestampPresent = typeof tx.timestamp === "number";
  report.timestampType = typeof tx.timestamp;
  if (typeof tx.timestamp === "number" && tx.timestamp > 1e12) {
    report.timestampAppearsMilliseconds = true;
  }

  return report;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  if (!RPC_URL) { console.error("NIMIQ_RPC_URL not set"); process.exit(1); }

  const mode = process.argv[2];

  if (mode === "--discover") {
    console.log("RPC URL configured: yes");
    console.log("Scanning recent blocks for a tx with non-empty recipientData…");
    console.log("");

    let blockNum: number;
    try {
      blockNum = await getBlockNumber();
      console.log(`Latest block: ${blockNum}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`FAIL: Could not get block number — ${msg}`);
      process.exit(1);
    }

    const MAX_BLOCKS = 250;
    let foundReport: ProbeReport | null = null;
    let blocksScanned = 0;

    for (let i = 0; i < MAX_BLOCKS; i++) {
      const bn = blockNum - i;
      if (bn < 0) break;

      try {
        const txs = await getBlockTransactions(bn);
        blocksScanned++;

        for (const tx of txs) {
          const report = inspect(tx);
          if (report.foundNonEmptyRecipientData) {
            report.blocksScanned = blocksScanned;
            foundReport = report;
            break;
          }
        }
        if (foundReport) break;
      } catch {
        // Skip blocks that fail to load
      }

      // Rate limit: 200ms between block requests
      if (i < MAX_BLOCKS - 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (!foundReport) {
      console.log(`Scanned ${blocksScanned} blocks.`);
      console.log("No transaction with non-empty recipientData found in the scan window.");
      console.log("");
      console.log("Suggestions:");
      console.log("  - The network may not have transactions with attached data yet.");
      console.log("  - Try a known tx hash directly: node --env-file=.env.local --import tsx src/lib/nimiq/rpc-probe.ts <hash>");
      process.exit(0);
    }

    console.log(`Found after scanning ${foundReport.blocksScanned} blocks.`);
    console.log("");
    console.log("=== PROBE REPORT ===");
    console.log(`  Transaction shape: ${foundReport.transactionShape}`);
    if (foundReport.nestedFieldName) console.log(`  Nested in: result.${foundReport.nestedFieldName}`);
    console.log(`  Hash present: ${foundReport.hashFieldPresent} (type: ${foundReport.hashFieldType})`);
    console.log(`  recipientData present: ${foundReport.recipientDataPresent}`);
    console.log(`  recipientData type: ${foundReport.recipientDataType}`);
    console.log(`  recipientData length: ${foundReport.recipientDataLength}`);
    console.log(`  recipientData matches lowercase hex: ${foundReport.recipientDataMatchesLowerHex}`);
    console.log(`  recipientData has even hex length: ${foundReport.recipientDataHasEvenHexLength}`);
    console.log(`  recipientData decodes to valid UTF-8: ${foundReport.recipientDataDecodesUtf8}`);
    console.log(`  networkId present: ${foundReport.networkIdPresent} (type: ${foundReport.networkIdType}, value: ${foundReport.networkIdValue ?? "N/A"})`);
    console.log(`  executionResult present: ${foundReport.executionResultPresent} (type: ${foundReport.executionResultType}, location: ${foundReport.executionResultLocation})`);
    console.log(`  Block height field: ${foundReport.blockHeightField ?? "not found"}`);
    console.log(`  timestamp present: ${foundReport.timestampPresent} (type: ${foundReport.timestampType})`);
    console.log(`  timestamp appears to be milliseconds: ${foundReport.timestampAppearsMilliseconds}`);
    process.exit(0);
  }

  // Single-hash probe mode
  const hash = mode;
  if (!hash || hash.startsWith("--")) {
    console.error("Usage: node --env-file=.env.local --import tsx src/lib/nimiq/rpc-probe.ts <tx-hash>");
    console.error("   or: node --env-file=.env.local --import tsx src/lib/nimiq/rpc-probe.ts --discover");
    process.exit(1);
  }

  console.log("Probing:", hash.slice(0, 12) + "...");
  const { getTransactionByHash } = await import("@/lib/nimiq/rpc");
  const result = await getTransactionByHash(hash);

  if ("error" in result) {
    console.log("RPC result: error:", result.error, result.message);
    process.exit(0);
  }

  const tx = result.data;
  console.log("Fields present:");
  console.log("  sender:", typeof tx.sender);
  console.log("  recipient:", typeof tx.recipient);
  console.log("  valueLuna (bigint):", String(tx.valueLuna));
  console.log("  recipientData:", typeof tx.recipientData, tx.recipientData ? `length=${tx.recipientData.length}` : "MISSING");
  console.log("  executionResult:", tx.executionResult);
  console.log("  networkId:", tx.networkId);
  console.log("  blockHeight:", tx.blockHeight);
  console.log("  timestampMs:", tx.timestampMs);
}

main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : String(e)); process.exit(1); });
