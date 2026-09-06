import { describe, expect, it } from "vitest";
import { Address } from "@nimiq/core";
import {
  createNimiqTransactionObservationAdapter,
} from "@/lib/nimiq/observation";
import {
  reconcileRewardFunding,
  type ExpectedFunding,
} from "@/lib/rewards/reconciliation";

const HASH = "a".repeat(64);
const OLD_BLOCK_HASH = "b".repeat(64);
const MICRO_BLOCK_HASH = "c".repeat(64);
const MACRO_BLOCK_HASH = "d".repeat(64);
const SENDER = "ab".repeat(20);
const VAULT = "cd".repeat(20);
const VAULT_NQ = Address.fromString(VAULT).toUserFriendlyAddress();
const BATCH = 7;
const MICRO_HEIGHT = 100;
const MACRO_HEIGHT = 105;

const expectedFunding: ExpectedFunding = {
  networkId: 42,
  transactionHash: HASH,
  vaultAddress: VAULT,
  amountLuna: BigInt(9000),
  memo: "votum-reward:campaign-test-1",
};

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    hash: HASH,
    from: SENDER,
    to: VAULT_NQ,
    value: 9000,
    recipientData: Buffer.from(expectedFunding.memo ?? "", "utf8").toString("hex"),
    networkId: 42,
    executionResult: true,
    blockNumber: MICRO_HEIGHT,
    timestamp: 1_725_000_000_000,
    confirmations: 0,
    ...overrides,
  };
}

function block(overrides: Record<string, unknown> = {}) {
  return {
    hash: MICRO_BLOCK_HASH,
    number: MICRO_HEIGHT,
    batch: BATCH,
    type: "micro",
    transactions: [{ hash: HASH }],
    ...overrides,
  };
}

function rpcResponse(data: unknown) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { data },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function rpcError() {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32000, message: "temporary RPC failure" },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createFetch(options: {
  head?: Record<string, unknown>;
  transaction?: Record<string, unknown>;
  block?: Record<string, unknown>;
  failMethod?: string;
  failMacroBlock?: boolean;
}) {
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    if (body.method === options.failMethod ||
      (options.failMacroBlock && body.method === "getBlockByNumber" && body.params[0] === MACRO_HEIGHT)) {
      return rpcError();
    }
    switch (body.method) {
      case "getTransactionByHash":
        return rpcResponse({ ...transaction(), ...options.transaction });
      case "getLatestBlock":
        return rpcResponse({
          ...block({
            hash: MACRO_BLOCK_HASH,
            number: MACRO_HEIGHT,
            type: "macro",
            transactions: undefined,
            ...options.head,
          }),
        });
      case "getBlockByNumber":
        return rpcResponse(body.params[0] === MACRO_HEIGHT
          ? { ...block({
            hash: MACRO_BLOCK_HASH,
            number: MACRO_HEIGHT,
            type: "macro",
            transactions: undefined,
          }) }
          : { ...block(), ...options.block });
      case "getBatchAt":
        return rpcResponse(BATCH);
      case "getMacroBlockOf":
        return rpcResponse(MACRO_HEIGHT);
      default:
        return rpcError();
    }
  };
}

function adapter(options: Parameters<typeof createFetch>[0] = {}) {
  return createNimiqTransactionObservationAdapter({
    rpcUrl: "http://127.0.0.1:9124",
    fetchImpl: createFetch(options),
  });
}

describe("Nimiq canonical finality observation", () => {
  it("confirms only after canonical inclusion and the batch finalizing macro block", async () => {
    const result = await adapter().observeFundingByHash(HASH);

    expect(result).toMatchObject({
      kind: "found",
      transaction: {
        finality: "final",
        finalityReason: null,
        finalityEvidence: {
          transactionBlockHeight: MICRO_HEIGHT,
          canonicalBlockHash: MICRO_BLOCK_HASH,
          canonicalBlockVerified: true,
          batchNumber: BATCH,
          finalizingMacroBlockHeight: MACRO_HEIGHT,
          finalizingMacroBlockHash: MACRO_BLOCK_HASH,
        },
      },
    });

    expect(reconcileRewardFunding(expectedFunding, result)).toMatchObject({
      status: "confirmed",
      reasonCode: "confirmed_success",
      confirmed: true,
    });
  });

  it("does not use a confirmation count as a substitute for macro finality", async () => {
    const result = await adapter({ head: { number: MACRO_HEIGHT - 1 } }).observeFundingByHash(HASH);

    expect(result).toMatchObject({
      kind: "found",
      transaction: { confirmationCount: 0, finality: "not_final", finalityReason: "observed_not_final" },
    });
    expect(reconcileRewardFunding(expectedFunding, result)).toMatchObject({
      status: "pending",
      confirmed: false,
    });
  });

  it("keeps a transaction pending when its observed block hash is not canonical", async () => {
    const result = await adapter({ transaction: { blockHash: OLD_BLOCK_HASH } }).observeFundingByHash(HASH);

    expect(result).toMatchObject({
      kind: "found",
      transaction: {
        finality: "not_final",
        finalityReason: "canonical_block_mismatch",
        finalityEvidence: { canonicalBlockVerified: false },
      },
    });
    expect(reconcileRewardFunding(expectedFunding, result)).toMatchObject({
      status: "pending",
      reasonCode: "canonical_block_mismatch",
      confirmed: false,
    });
  });

  it("keeps a transaction pending when the canonical block body no longer contains it", async () => {
    const result = await adapter({ block: { transactions: [] } }).observeFundingByHash(HASH);

    expect(result).toMatchObject({
      kind: "found",
      transaction: { finality: "not_final", finalityReason: "canonical_block_mismatch" },
    });
    expect(reconcileRewardFunding(expectedFunding, result).confirmed).toBe(false);
  });

  it.each([
    ["getLatestBlock", {}],
    ["getBlockByNumber", {}],
    ["getBatchAt", {}],
    ["getMacroBlockOf", {}],
  ])("returns retryable when %s cannot be read", async (method, options) => {
    const result = await adapter({ ...options, failMethod: method }).observeFundingByHash(HASH);

    expect(result).toEqual({ kind: "rpc_error", code: "rpc_unavailable" });
    expect(reconcileRewardFunding(expectedFunding, result)).toMatchObject({
      status: "retryable",
      confirmed: false,
    });
  });

  it("returns retryable when the finalizing macro block cannot be read", async () => {
    const result = await adapter({ failMacroBlock: true }).observeFundingByHash(HASH);

    expect(result).toEqual({ kind: "rpc_error", code: "rpc_unavailable" });
    expect(reconcileRewardFunding(expectedFunding, result)).toMatchObject({
      status: "retryable",
      confirmed: false,
    });
  });

  it("does not confirm an execution failure even when its block is finalized", async () => {
    const result = await adapter({ transaction: { executionResult: false } }).observeFundingByHash(HASH);

    expect(reconcileRewardFunding(expectedFunding, result)).toMatchObject({
      status: "rejected",
      reasonCode: "execution_failed",
      confirmed: false,
    });
  });

  it("returns unknown finality when the transaction has no block yet", async () => {
    const result = await adapter({ transaction: { blockNumber: null } }).observeFundingByHash(HASH);

    expect(result).toMatchObject({
      kind: "found",
      transaction: { finality: "unknown", finalityReason: "finality_unknown" },
    });
    expect(reconcileRewardFunding(expectedFunding, result)).toMatchObject({
      status: "pending",
      reasonCode: "finality_unknown",
      confirmed: false,
    });
  });
});
