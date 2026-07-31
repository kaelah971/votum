/**
 * Nimiq JSON-RPC adapter (server-only).
 *
 * Provides a typed minimal RPC client for transaction verification.
 * Uses NIMIQ_RPC_URL environment variable — never exposed to clients.
 */

import "server-only";

const RPC_URL = process.env.NIMIQ_RPC_URL;

export type RpcStatus = "configured" | "unconfigured";

export function getRpcStatus(): RpcStatus {
  return RPC_URL ? "configured" : "unconfigured";
}

interface Transaction {
  hash: string;
  blockNumber?: number;
  timestamp?: number;
  from: string;
  to: string;
  value: number;
  fee: number;
  data?: string;
  flags: number;
  validityStartHeight: number;
  proof?: string;
  networkId?: number;
  executionResult?: boolean;
}

interface RpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

export async function getTransactionByHash(
  hash: string,
): Promise<{ data: Transaction } | { error: string }> {
  if (!RPC_URL) return { error: "NIMIQ_RPC_URL not configured" };

  try {
    const body = {
      jsonrpc: "2.0",
      method: "getTransactionByHash",
      params: [hash],
      id: 1,
    };

    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      return { error: `RPC returned HTTP ${res.status}` };
    }

    const json = (await res.json()) as RpcResponse<Transaction>;
    if (json.error) {
      if (json.error.message?.includes("not found") || json.error.code === -1) {
        return { error: "not_found" };
      }
      return { error: json.error.message || `RPC error ${json.error.code}` };
    }

    const tx = json.result;
    if (!tx) return { error: "not_found" };
    return { data: tx };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "RPC request failed" };
  }
}
