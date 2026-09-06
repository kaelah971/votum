import "server-only";

import type {
  FundingObservation,
  ObservedFundingTransaction,
} from "@/lib/rewards/reconciliation";

interface JsonRpcError {
  code?: unknown;
  message?: unknown;
}

export interface NimiqTransactionObservationAdapter {
  observeTransactionByHash(hash: string): Promise<FundingObservation>;
}

export interface NimiqTransactionObservationAdapterOptions {
  rpcUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value.trim());
}

function decodeRecipientData(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || (value.length > 0 && !/^[0-9a-f]+$/.test(value)) || value.length % 2 !== 0) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "hex"));
  } catch {
    return undefined;
  }
}

function optionalInteger(
  value: unknown,
  minimum = 0,
): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : undefined;
}

function rpcErrorToObservation(error: JsonRpcError): FundingObservation {
  const code = typeof error.code === "number" ? error.code : null;
  const message = typeof error.message === "string" ? error.message : "";
  if (code === -1 || message.toLowerCase().includes("not found")) {
    return { kind: "not_found" };
  }
  return { kind: "rpc_error", code: "rpc_unavailable" };
}

/**
 * Normalize the currently observed Nimiq PoS `result.data` shape.
 *
 * The adapter does not infer finality from a block number or confirmation
 * count. A future proven network policy may provide an explicit finality value;
 * until then the normalized state remains `unknown`.
 */
export function normalizeNimiqRpcTransactionResponse(
  raw: unknown,
): FundingObservation {
  const envelope = asRecord(raw);
  if (!envelope) {
    return { kind: "malformed", reasonCode: "malformed_transaction" };
  }
  if (envelope.error !== undefined) {
    const error = asRecord(envelope.error) ?? {};
    return rpcErrorToObservation(error);
  }

  const result = asRecord(envelope.result);
  const transaction = asRecord(result?.data);
  if (!transaction) {
    return { kind: "malformed", reasonCode: "malformed_transaction" };
  }

  if (
    !isHash(transaction.hash) ||
    typeof transaction.from !== "string" ||
    typeof transaction.to !== "string" ||
    typeof transaction.value !== "number" ||
    !Number.isSafeInteger(transaction.value) ||
    transaction.value < 0
  ) {
    return { kind: "malformed", reasonCode: "malformed_transaction" };
  }

  const memo = decodeRecipientData(transaction.recipientData);
  if (memo === undefined) {
    return { kind: "malformed", reasonCode: "malformed_transaction" };
  }

  let executionResult: boolean | null = null;
  if (transaction.executionResult !== undefined && transaction.executionResult !== null) {
    if (typeof transaction.executionResult !== "boolean") {
      return { kind: "malformed", reasonCode: "malformed_transaction" };
    }
    executionResult = transaction.executionResult;
  }

  let networkId: number | null = null;
  if (transaction.networkId !== undefined && transaction.networkId !== null) {
    if (
      typeof transaction.networkId !== "number" ||
      !Number.isSafeInteger(transaction.networkId)
    ) {
      return { kind: "malformed", reasonCode: "malformed_transaction" };
    }
    networkId = transaction.networkId;
  }

  const blockHeight = optionalInteger(transaction.blockNumber);
  const timestampMs = optionalInteger(transaction.timestamp);
  const confirmationCount = optionalInteger(transaction.confirmations);
  if (
    blockHeight === undefined ||
    timestampMs === undefined ||
    confirmationCount === undefined
  ) {
    return { kind: "malformed", reasonCode: "malformed_transaction" };
  }

  let finality: ObservedFundingTransaction["finality"] = "unknown";
  if (transaction.finality === "final" || transaction.finality === "not_final") {
    finality = transaction.finality;
  } else if (transaction.finality !== undefined && transaction.finality !== null) {
    return { kind: "malformed", reasonCode: "malformed_transaction" };
  }

  return {
    kind: "found",
    transaction: {
      transactionHash: transaction.hash.trim().toLowerCase(),
      networkId,
      sender: transaction.from,
      recipient: transaction.to,
      valueLuna: BigInt(transaction.value),
      memo,
      executionResult,
      blockHeight,
      timestampMs,
      confirmationCount,
      finality,
    },
  };
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export function createNimiqTransactionObservationAdapter(
  options: NimiqTransactionObservationAdapterOptions = {},
): NimiqTransactionObservationAdapter {
  const rpcUrl = options.rpcUrl ?? process.env.NIMIQ_RPC_URL;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async observeTransactionByHash(hash: string): Promise<FundingObservation> {
      if (!isHash(hash)) {
        return { kind: "malformed", reasonCode: "malformed_transaction" };
      }
      if (!rpcUrl) {
        return { kind: "rpc_error", code: "rpc_unavailable" };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "getTransactionByHash",
            params: [hash.trim().toLowerCase()],
            id: 1,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          return { kind: "rpc_error", code: "rpc_unavailable" };
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return { kind: "malformed", reasonCode: "malformed_transaction" };
        }
        return normalizeNimiqRpcTransactionResponse(body);
      } catch (error) {
        return {
          kind: "rpc_error",
          code: isAbortError(error) ? "rpc_timeout" : "rpc_unavailable",
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
