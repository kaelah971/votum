import "server-only";

export type NimiqBroadcastResult =
  | { kind: "broadcast"; transactionHash: string }
  | { kind: "definitely_not_broadcast"; errorCode: "broadcast_rejected" }
  | { kind: "unknown"; errorCode: "broadcast_timeout" | "broadcast_unavailable" }
  | { kind: "malformed"; errorCode: "broadcast_response_malformed" };

export interface NimiqBroadcastAdapterOptions {
  rpcUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface NimiqBroadcastAdapter {
  broadcastTransaction(serializedTransactionHex: string): Promise<NimiqBroadcastResult>;
  getBlockNumber(): Promise<number>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function normalizeHash(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value.trim())) return null;
  return value.trim().toLowerCase();
}

function unwrapResult(value: unknown): unknown {
  const record = asRecord(value);
  return record && "data" in record ? record.data : value;
}

function responseHash(value: unknown): string | null {
  const unwrapped = unwrapResult(value);
  const direct = normalizeHash(unwrapped);
  if (direct) return direct;
  const record = asRecord(unwrapped);
  return normalizeHash(record?.hash) ?? normalizeHash(record?.transactionHash);
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "name" in error && (error as { name?: unknown }).name === "AbortError";
}

/**
 * Server-only Nimiq PoS JSON-RPC adapter for raw signed transaction broadcast.
 * A timeout, transport error, or malformed success response is deliberately
 * unknown: the request may have reached the node and must not be resent.
 */
export function createNimiqBroadcastAdapter(
  options: NimiqBroadcastAdapterOptions = {},
): NimiqBroadcastAdapter {
  const rpcUrl = options.rpcUrl ?? process.env.NIMIQ_RPC_URL;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function callRpc(method: string, params: unknown[]): Promise<
    | { kind: "body"; body: unknown }
    | { kind: "timeout" }
    | { kind: "unavailable" }
  > {
    if (!rpcUrl) return { kind: "unavailable" };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method,
          params,
          id: 1,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return { kind: "unavailable" };
      try {
        return { kind: "body", body: await response.json() };
      } catch {
        return { kind: "unavailable" };
      }
    } catch (error) {
      return { kind: isAbortError(error) ? "timeout" : "unavailable" };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function broadcastTransaction(
    serializedTransactionHex: string,
  ): Promise<NimiqBroadcastResult> {
    if (!/^[0-9a-fA-F]+$/.test(serializedTransactionHex) || serializedTransactionHex.length % 2 !== 0) {
      return { kind: "malformed", errorCode: "broadcast_response_malformed" };
    }

    const result = await callRpc("sendTransaction", [serializedTransactionHex.toLowerCase()]);
    if (result.kind === "timeout") return { kind: "unknown", errorCode: "broadcast_timeout" };
    if (result.kind === "unavailable") return { kind: "unknown", errorCode: "broadcast_unavailable" };

    const envelope = asRecord(result.body);
    if (!envelope) return { kind: "malformed", errorCode: "broadcast_response_malformed" };
    if (envelope.error !== undefined) {
      return { kind: "definitely_not_broadcast", errorCode: "broadcast_rejected" };
    }

    const hash = responseHash(envelope.result);
    return hash
      ? { kind: "broadcast", transactionHash: hash }
      : { kind: "malformed", errorCode: "broadcast_response_malformed" };
  }

  async function getBlockNumber(): Promise<number> {
    const result = await callRpc("getBlockNumber", []);
    if (result.kind === "timeout") throw new Error("nimiq_block_height_timeout");
    if (result.kind === "unavailable") throw new Error("nimiq_block_height_unavailable");

    const envelope = asRecord(result.body);
    if (!envelope || envelope.error !== undefined) throw new Error("nimiq_block_height_unavailable");
    const value = unwrapResult(envelope.result);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error("nimiq_block_height_malformed");
    }
    return value;
  }

  return { broadcastTransaction, getBlockNumber };
}
