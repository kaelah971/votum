import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Address } from "@nimiq/core";
import {
  createNimiqTransactionObservationAdapter,
  normalizeNimiqRpcTransactionResponse,
} from "@/lib/nimiq/observation";

const HASH = "a".repeat(64);
const SENDER = "ab".repeat(20);
const RECIPIENT = "cd".repeat(20);
const RECIPIENT_NQ = Address.fromString(RECIPIENT).toUserFriendlyAddress();

function rpcTransaction(overrides: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      data: {
        hash: HASH,
        from: SENDER,
        to: RECIPIENT_NQ,
        value: 9000,
        recipientData: Buffer.from("votum-reward:campaign-test-1", "utf8").toString("hex"),
        networkId: 42,
        executionResult: true,
        blockNumber: 12345,
        timestamp: 1_725_000_000_000,
        confirmations: 3,
        ...overrides,
      },
    },
  };
}

describe("Nimiq observation adapter", () => {
  it("normalizes the current nested RPC transaction shape without claiming finality", () => {
    const result = normalizeNimiqRpcTransactionResponse(rpcTransaction());

    expect(result).toEqual({
      kind: "found",
      transaction: {
        transactionHash: HASH,
        blockHash: null,
        networkId: 42,
        sender: SENDER,
        recipient: RECIPIENT_NQ,
        valueLuna: BigInt(9000),
        memo: "votum-reward:campaign-test-1",
        executionResult: true,
        blockHeight: 12345,
        timestampMs: 1_725_000_000_000,
        confirmationCount: 3,
        finality: "unknown",
        finalityReason: null,
        finalityEvidence: null,
      },
    });
  });

  it("preserves explicit failed and missing execution states for the domain", () => {
    expect(
      normalizeNimiqRpcTransactionResponse(rpcTransaction({ executionResult: false })),
    ).toMatchObject({
      kind: "found",
      transaction: { executionResult: false },
    });
    expect(
      normalizeNimiqRpcTransactionResponse(rpcTransaction({ executionResult: undefined })),
    ).toMatchObject({
      kind: "found",
      transaction: { executionResult: null },
    });
  });

  it("maps not-found RPC responses conservatively", () => {
    const result = normalizeNimiqRpcTransactionResponse({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -1, message: "Transaction not found" },
    });

    expect(result).toEqual({ kind: "not_found" });
  });

  it("maps malformed RPC transactions to safe failure", () => {
    const result = normalizeNimiqRpcTransactionResponse(
      rpcTransaction({ value: "9000" }),
    );

    expect(result).toMatchObject({
      kind: "malformed",
      reasonCode: "malformed_transaction",
    });
  });

  it("keeps transport failures retryable and identifies aborts as timeouts", async () => {
    const unavailable = createNimiqTransactionObservationAdapter({
      rpcUrl: "http://127.0.0.1:9124",
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });
    const timeout = createNimiqTransactionObservationAdapter({
      rpcUrl: "http://127.0.0.1:9124",
      fetchImpl: async () => {
        throw { name: "AbortError" };
      },
    });

    await expect(unavailable.observeTransactionByHash(HASH)).resolves.toEqual({
      kind: "rpc_error",
      code: "rpc_unavailable",
    });
    await expect(timeout.observeTransactionByHash(HASH)).resolves.toEqual({
      kind: "rpc_error",
      code: "rpc_timeout",
    });
  });

  it("fetches by hash through the injected RPC transport without signing or broadcasting", async () => {
    const calls: Array<{ method?: string; params?: unknown[] }> = [];
    const adapter = createNimiqTransactionObservationAdapter({
      rpcUrl: "http://127.0.0.1:9124",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { method?: string; params?: unknown[] };
        calls.push(body);
        return new Response(JSON.stringify(rpcTransaction()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const result = await adapter.observeTransactionByHash(HASH);

    expect(result.kind).toBe("found");
    expect(calls).toEqual([{
      jsonrpc: "2.0",
      id: 1,
      method: "getTransactionByHash",
      params: [HASH],
    }]);
    expect(result).not.toHaveProperty("privateKey");
  });
});

describe("observation security boundary", () => {
  it("does not import private vault modules or expose signing/broadcast primitives", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/nimiq/observation.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/vault-(key|service|signing)/);
    expect(source).not.toContain("REWARD_VAULT_MASTER_KEY");
    expect(source).not.toMatch(/\bsendTransaction\b/);
    expect(source).not.toMatch(/\bsign\s*\(/);
  });
});
