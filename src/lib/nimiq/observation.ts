import "server-only";

import type {
  FundingFinality,
  FundingFinalityEvidence,
  FundingFinalityReason,
  FundingObservation,
  ObservedFundingTransaction,
} from "@/lib/rewards/reconciliation";

interface JsonRpcError {
  code?: unknown;
  message?: unknown;
}

type RpcCallResult =
  | { kind: "body"; body: unknown }
  | { kind: "rpc_error"; code: "rpc_unavailable" | "rpc_timeout" }
  | { kind: "malformed" };

type RpcDataResult =
  | { kind: "data"; data: unknown }
  | { kind: "rpc_error"; code: "rpc_unavailable" | "rpc_timeout" }
  | { kind: "malformed" };

export type NimiqFinalityObservation =
  | {
      kind: "finality";
      finality: FundingFinality;
      reasonCode: FundingFinalityReason | null;
      evidence: FundingFinalityEvidence;
    }
  | { kind: "rpc_error"; code: "rpc_unavailable" | "rpc_timeout" }
  | { kind: "malformed"; reasonCode: "malformed_transaction" };

export interface NimiqTransactionObservationAdapter {
  observeTransactionByHash(hash: string): Promise<FundingObservation>;
  observeFinality(transaction: ObservedFundingTransaction): Promise<NimiqFinalityObservation>;
  observeFundingByHash(hash: string): Promise<FundingObservation>;
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
  if (
    typeof value !== "string" ||
    (value.length > 0 && !/^[0-9a-f]+$/.test(value)) ||
    value.length % 2 !== 0
  ) {
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

function rpcErrorFromBody(body: unknown): JsonRpcError | null {
  const envelope = asRecord(body);
  if (!envelope || envelope.error === undefined) return null;
  return asRecord(envelope.error) ?? {};
}

function dataFromRpcResult(result: RpcCallResult): RpcDataResult {
  if (result.kind !== "body") return result;
  if (rpcErrorFromBody(result.body)) {
    return { kind: "rpc_error", code: "rpc_unavailable" };
  }
  const envelope = asRecord(result.body);
  const rpcResult = asRecord(envelope?.result);
  if (!rpcResult || !("data" in rpcResult)) return { kind: "malformed" };
  return { kind: "data", data: rpcResult.data };
}

/**
 * Normalize the current Nimiq PoS `result.data` transaction shape.
 *
 * This function deliberately leaves finality unknown. Finality is established
 * only by the server-side canonical block and macro-block observation below.
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

  let blockHash: string | null = null;
  if (transaction.blockHash !== undefined && transaction.blockHash !== null) {
    if (!isHash(transaction.blockHash)) {
      return { kind: "malformed", reasonCode: "malformed_transaction" };
    }
    blockHash = transaction.blockHash.trim().toLowerCase();
  }

  return {
    kind: "found",
    transaction: {
      transactionHash: transaction.hash.trim().toLowerCase(),
      blockHash,
      networkId,
      sender: transaction.from,
      recipient: transaction.to,
      valueLuna: BigInt(transaction.value),
      memo,
      executionResult,
      blockHeight,
      timestampMs,
      confirmationCount,
      finality: "unknown",
      finalityReason: null,
      finalityEvidence: null,
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

function finalityEvidence(
  transaction: ObservedFundingTransaction,
  overrides: Partial<FundingFinalityEvidence> = {},
): FundingFinalityEvidence {
  return {
    transactionBlockHeight: transaction.blockHeight,
    transactionBlockHash: transaction.blockHash,
    canonicalBlockHash: null,
    canonicalBlockVerified: false,
    batchNumber: null,
    finalizingMacroBlockHeight: null,
    finalizingMacroBlockHash: null,
    ...overrides,
  };
}

function finalityResult(
  transaction: ObservedFundingTransaction,
  finality: FundingFinality,
  reasonCode: FundingFinalityReason | null,
  evidence: Partial<FundingFinalityEvidence> = {},
): NimiqFinalityObservation {
  return {
    kind: "finality",
    finality,
    reasonCode,
    evidence: finalityEvidence(transaction, evidence),
  };
}

interface ParsedBlock {
  hash: string;
  number: number;
  batch: number | null;
  type: "macro" | "micro" | null;
  transactions: unknown[] | null;
}

function parseBlock(value: unknown, requireBody: boolean): ParsedBlock | null {
  const block = asRecord(value);
  if (!block || !isHash(block.hash)) return null;
  const number = optionalInteger(block.number);
  const batch = optionalInteger(block.batch);
  if (number === undefined || number === null || batch === undefined || batch === null) {
    return null;
  }

  let type: ParsedBlock["type"] = null;
  if (block.type === "macro" || block.type === "micro") type = block.type;
  if (requireBody && !Array.isArray(block.transactions)) return null;

  return {
    hash: block.hash.trim().toLowerCase(),
    number,
    batch,
    type,
    transactions: Array.isArray(block.transactions) ? block.transactions : null,
  };
}

function blockContainsTransaction(block: ParsedBlock, transactionHash: string): boolean {
  if (!block.transactions) return false;
  const expectedHash = transactionHash.trim().toLowerCase();
  return block.transactions.some((entry) => {
    const record = asRecord(entry);
    const directHash = record?.hash;
    const nestedTransaction = asRecord(record?.transaction);
    const nestedHash = nestedTransaction?.hash;
    return (isHash(directHash) ? directHash : isHash(nestedHash) ? nestedHash : "")
      .trim()
      .toLowerCase() === expectedHash;
  });
}

export function createNimiqTransactionObservationAdapter(
  options: NimiqTransactionObservationAdapterOptions = {},
): NimiqTransactionObservationAdapter {
  const rpcUrl = options.rpcUrl ?? process.env.NIMIQ_RPC_URL;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function callRpc(method: string, params: unknown[]): Promise<RpcCallResult> {
    if (!rpcUrl) return { kind: "rpc_error", code: "rpc_unavailable" };

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
      if (!response.ok) {
        return { kind: "rpc_error", code: "rpc_unavailable" };
      }
      try {
        return { kind: "body", body: await response.json() };
      } catch {
        return { kind: "malformed" };
      }
    } catch (error) {
      return {
        kind: "rpc_error",
        code: isAbortError(error) ? "rpc_timeout" : "rpc_unavailable",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getRpcData(method: string, params: unknown[]): Promise<RpcDataResult> {
    return dataFromRpcResult(await callRpc(method, params));
  }

  async function observeTransactionByHash(hash: string): Promise<FundingObservation> {
    if (!isHash(hash)) {
      return { kind: "malformed", reasonCode: "malformed_transaction" };
    }
    const result = await callRpc("getTransactionByHash", [hash.trim().toLowerCase()]);
    if (result.kind === "rpc_error") return result;
    if (result.kind === "malformed") {
      return { kind: "malformed", reasonCode: "malformed_transaction" };
    }
    return normalizeNimiqRpcTransactionResponse(result.body);
  }

  async function observeFinality(
    transaction: ObservedFundingTransaction,
  ): Promise<NimiqFinalityObservation> {
    if (!isHash(transaction.transactionHash)) {
      return { kind: "malformed", reasonCode: "malformed_transaction" };
    }
    if (transaction.blockHeight === null) {
      return finalityResult(transaction, "unknown", "finality_unknown");
    }

    const headResult = await getRpcData("getLatestBlock", [false]);
    if (headResult.kind === "rpc_error") return headResult;
    if (headResult.kind === "malformed") {
      return { kind: "malformed", reasonCode: "malformed_transaction" };
    }
    const head = parseBlock(headResult.data, false);
    if (!head) return { kind: "malformed", reasonCode: "malformed_transaction" };

    if (transaction.blockHeight > head.number) {
      return finalityResult(transaction, "not_final", "canonical_block_mismatch");
    }

    const canonicalResult = await getRpcData("getBlockByNumber", [transaction.blockHeight, true]);
    if (canonicalResult.kind === "rpc_error") return canonicalResult;
    if (canonicalResult.kind === "malformed") {
      return { kind: "malformed", reasonCode: "malformed_transaction" };
    }
    const canonicalBlock = parseBlock(canonicalResult.data, true);
    if (!canonicalBlock) {
      return { kind: "malformed", reasonCode: "malformed_transaction" };
    }

    const canonicalBlockMatches =
      canonicalBlock.number === transaction.blockHeight &&
      canonicalBlock.type === "micro" &&
      (transaction.blockHash === null ||
        canonicalBlock.hash === transaction.blockHash.trim().toLowerCase()) &&
      blockContainsTransaction(canonicalBlock, transaction.transactionHash);
    const canonicalEvidence = {
      canonicalBlockHash: canonicalBlock.hash,
      canonicalBlockVerified: canonicalBlockMatches,
    };
    if (!canonicalBlockMatches) {
      return finalityResult(
        transaction,
        "not_final",
        "canonical_block_mismatch",
        canonicalEvidence,
      );
    }

    const batchResult = await getRpcData("getBatchAt", [transaction.blockHeight]);
    if (batchResult.kind === "rpc_error") return batchResult;
    if (batchResult.kind === "malformed") {
      return { kind: "malformed", reasonCode: "malformed_transaction" };
    }
    const batchNumber = optionalInteger(batchResult.data);
    if (batchNumber === undefined || batchNumber === null) {
      return { kind: "malformed", reasonCode: "malformed_transaction" };
    }

    const macroResult = await getRpcData("getMacroBlockOf", [batchNumber]);
    if (macroResult.kind === "rpc_error") return macroResult;
    if (macroResult.kind === "malformed") {
      return { kind: "malformed", reasonCode: "malformed_transaction" };
    }
    const macroHeight = optionalInteger(macroResult.data);
    if (macroHeight === undefined || macroHeight === null) {
      return { kind: "malformed", reasonCode: "malformed_transaction" };
    }

    const batchEvidence = { ...canonicalEvidence, batchNumber };
    if (macroHeight > head.number) {
      return finalityResult(transaction, "not_final", "observed_not_final", {
        ...batchEvidence,
        finalizingMacroBlockHeight: macroHeight,
      });
    }

    const macroBlockResult = await getRpcData("getBlockByNumber", [macroHeight, false]);
    if (macroBlockResult.kind === "rpc_error") return macroBlockResult;
    if (macroBlockResult.kind === "malformed") {
      return { kind: "malformed", reasonCode: "malformed_transaction" };
    }
    const macroBlock = parseBlock(macroBlockResult.data, false);
    if (!macroBlock) {
      return { kind: "malformed", reasonCode: "malformed_transaction" };
    }

    const macroBlockMatches =
      macroBlock.number === macroHeight &&
      macroHeight >= transaction.blockHeight &&
      macroBlock.type === "macro" &&
      macroBlock.batch === batchNumber;
    if (!macroBlockMatches) {
      return finalityResult(transaction, "not_final", "canonical_block_mismatch", {
        ...batchEvidence,
        finalizingMacroBlockHeight: macroHeight,
        finalizingMacroBlockHash: macroBlock.hash,
      });
    }

    return finalityResult(transaction, "final", null, {
      ...batchEvidence,
      finalizingMacroBlockHeight: macroHeight,
      finalizingMacroBlockHash: macroBlock.hash,
    });
  }

  async function observeFundingByHash(hash: string): Promise<FundingObservation> {
    const observation = await observeTransactionByHash(hash);
    if (observation.kind !== "found") return observation;

    const finality = await observeFinality(observation.transaction);
    if (finality.kind === "rpc_error") return finality;
    if (finality.kind === "malformed") return finality;
    return {
      kind: "found",
      transaction: {
        ...observation.transaction,
        finality: finality.finality,
        finalityReason: finality.reasonCode,
        finalityEvidence: finality.evidence,
      },
    };
  }

  return {
    observeTransactionByHash,
    observeFinality,
    observeFundingByHash,
  };
}
