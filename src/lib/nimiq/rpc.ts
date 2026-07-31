/**
 * Nimiq PoS JSON-RPC adapter (server-only).
 *
 * Translates the actual PoS getTransactionByHash response shape
 * into a strict normalized internal transaction type.
 *
 * Uses NIMIQ_RPC_URL and NIMIQ_NETWORK_ID — never exposed to clients.
 */

import "server-only";

const RPC_URL = process.env.NIMIQ_RPC_URL;
const NETWORK_ID_RAW = process.env.NIMIQ_NETWORK_ID;
const NETWORK_ID: number | null = NETWORK_ID_RAW ? parseInt(NETWORK_ID_RAW, 10) : null;

export type RpcStatus = "configured" | "unconfigured";

export function getRpcStatus(): RpcStatus {
  if (!RPC_URL || NETWORK_ID === null || isNaN(NETWORK_ID)) return "unconfigured";
  return "configured";
}

// ── Internal normalized type ──────────────────────────────────────────

export interface IncludedNimiqTransaction {
  transactionHash: string;
  sender: string;          // from field
  recipient: string;       // to field
  valueLuna: bigint;       // value in Luna
  recipientData: string;   // attached memo (decoded)
  networkId: number;
  executionResult: true;   // must be explicitly true
  blockHeight: number | null;
  timestampMs: number | null;
}

// ── RPC request ────────────────────────────────────────────────────────

interface RpcEnvelope {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Nimiq PoS wraps the transaction in `result.data`.
 */
interface PosTransactionResponse {
  data: RawPosTransaction;
}

interface RawPosTransaction {
  hash: string;
  from: string;
  to: string;
  value: number;
  recipientData?: string;
  networkId?: number;
  executionResult?: boolean;
  blockNumber?: number;
  timestamp?: number;
}

// ── Memo decoder ──────────────────────────────────────────────────────

function decodeRecipientData(raw: string): string | null {
  // Try hex decode first (common for PoS)
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    try {
      const bytes = Buffer.from(raw, "hex");
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return decoded;
    } catch {
      return null;
    }
  }
  // Plain UTF-8 string
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(
      new TextEncoder().encode(raw),
    );
    return raw;
  } catch {
    return null;
  }
}

// ── Hash validation ───────────────────────────────────────────────────

export function validateTransactionHash(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) return null;
  return trimmed;
}

// ── Public API ────────────────────────────────────────────────────────

export async function getTransactionByHash(
  hash: string,
): Promise<
  | { data: IncludedNimiqTransaction }
  | { error: "not_found" | "rpc_error" | "malformed"; message: string }
> {
  if (!RPC_URL) return { error: "rpc_error", message: "NIMIQ_RPC_URL not configured" };
  if (NETWORK_ID === null) return { error: "rpc_error", message: "NIMIQ_NETWORK_ID not configured" };

  const validatedHash = validateTransactionHash(hash);
  if (!validatedHash) return { error: "malformed", message: "Invalid transaction hash format" };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "getTransactionByHash",
        params: [validatedHash],
        id: 1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return { error: "rpc_error", message: `RPC returned HTTP ${res.status}` };
    }

    const json = (await res.json()) as RpcEnvelope;
    if (json.error) {
      if (
        json.error.message?.toLowerCase().includes("not found") ||
        json.error.code === -1
      ) {
        return { error: "not_found", message: "Transaction not found" };
      }
      return {
        error: "rpc_error",
        message: json.error.message || `RPC error ${json.error.code}`,
      };
    }

    // PoS wraps in result.data
    const envelope = json.result as PosTransactionResponse | undefined;
    if (!envelope || typeof envelope !== "object") {
      return { error: "malformed", message: "Missing result.data envelope" };
    }
    const tx = envelope.data;
    if (!tx || typeof tx !== "object") {
      return { error: "malformed", message: "Missing transaction data in result" };
    }

    // Validate required fields
    if (typeof tx.hash !== "string" || !tx.hash) {
      return { error: "malformed", message: "Missing transaction hash" };
    }
    if (typeof tx.from !== "string" || !tx.from) {
      return { error: "malformed", message: "Missing sender (from)" };
    }
    if (typeof tx.to !== "string" || !tx.to) {
      return { error: "malformed", message: "Missing recipient (to)" };
    }
    if (typeof tx.value !== "number" || tx.value < 0) {
      return { error: "malformed", message: "Missing or invalid value" };
    }
    if (tx.executionResult !== true) {
      return { error: "malformed", message: "Transaction executionResult is not true" };
    }
    if (tx.networkId !== undefined && tx.networkId !== NETWORK_ID) {
      return { error: "malformed", message: `Network mismatch (expected ${NETWORK_ID}, got ${tx.networkId})` };
    }

    // Decode memo
    let memo = "";
    if (tx.recipientData) {
      const decoded = decodeRecipientData(tx.recipientData);
      if (decoded === null) {
        return { error: "malformed", message: "Could not decode recipientData" };
      }
      memo = decoded;
    }

    // Timestamp: Nimiq PoS uses milliseconds
    const timestampMs =
      typeof tx.timestamp === "number" && tx.timestamp > 0
        ? tx.timestamp
        : null;

    return {
      data: {
        transactionHash: tx.hash,
        sender: tx.from,
        recipient: tx.to,
        valueLuna: BigInt(tx.value),
        recipientData: memo,
        networkId: tx.networkId ?? NETWORK_ID,
        executionResult: true,
        blockHeight: typeof tx.blockNumber === "number" ? tx.blockNumber : null,
        timestampMs,
      },
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { error: "rpc_error", message: "RPC request timed out" };
    }
    return {
      error: "rpc_error",
      message: err instanceof Error ? err.message : "RPC request failed",
    };
  }
}
