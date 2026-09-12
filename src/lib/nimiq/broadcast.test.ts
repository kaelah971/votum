import { describe, expect, it } from "vitest";
import { createNimiqBroadcastAdapter } from "@/lib/nimiq/broadcast";

const HASH = "A".repeat(64).toLowerCase();
const HEX = "ab".repeat(16);

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("server Nimiq broadcast adapter", () => {
  it("normalizes a successful sendTransaction hash", async () => {
    const adapter = createNimiqBroadcastAdapter({
      rpcUrl: "http://local.test",
      fetchImpl: async () => response({ result: HASH.toUpperCase() }),
    });
    await expect(adapter.broadcastTransaction(HEX)).resolves.toEqual({
      kind: "broadcast",
      transactionHash: HASH,
    });
  });

  it("accepts the PoS result.data transaction shape", async () => {
    const adapter = createNimiqBroadcastAdapter({
      rpcUrl: "http://local.test",
      fetchImpl: async () => response({ result: { data: { hash: HASH } } }),
    });
    await expect(adapter.broadcastTransaction(HEX)).resolves.toMatchObject({ kind: "broadcast" });
  });

  it("classifies an explicit node rejection as definitely not broadcast", async () => {
    const adapter = createNimiqBroadcastAdapter({
      rpcUrl: "http://local.test",
      fetchImpl: async () => response({ error: { code: -32000, message: "invalid transaction" } }),
    });
    await expect(adapter.broadcastTransaction(HEX)).resolves.toEqual({
      kind: "definitely_not_broadcast",
      errorCode: "broadcast_rejected",
    });
  });

  it("classifies timeout as unknown and never treats it as a rejection", async () => {
    const adapter = createNimiqBroadcastAdapter({
      rpcUrl: "http://local.test",
      timeoutMs: 1,
      fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")));
      }),
    });
    await expect(adapter.broadcastTransaction(HEX)).resolves.toEqual({
      kind: "unknown",
      errorCode: "broadcast_timeout",
    });
  });

  it("classifies a malformed success response as unknown-safe malformed", async () => {
    const adapter = createNimiqBroadcastAdapter({
      rpcUrl: "http://local.test",
      fetchImpl: async () => response({ result: { data: { hash: "not-a-hash" } } }),
    });
    await expect(adapter.broadcastTransaction(HEX)).resolves.toEqual({
      kind: "malformed",
      errorCode: "broadcast_response_malformed",
    });
  });

  it("reads a server-side validity height without floating point conversion", async () => {
    const adapter = createNimiqBroadcastAdapter({
      rpcUrl: "http://local.test",
      fetchImpl: async () => response({ result: { data: 12345 } }),
    });
    await expect(adapter.getBlockNumber()).resolves.toBe(12345);
  });
});
