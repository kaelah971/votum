import { describe, it, expect, vi, afterEach } from "vitest";
import {
  sendBasicTransactionWithData,
  signMessage,
} from "@/lib/nimiq/client";

// Representative safe cancellation objects matching the physical SDK shape
// observed on Nimiq Pay. No secrets — these are just denial markers.
const CANCELLATION_VARIANTS = [
  // Plain object rejection (what the overlay showed as "[object Object]")
  { error: { type: "denied", message: "The user rejected the request" } },
  { type: "denied", message: "Request rejected" },
  { error: { type: "UserRejected", message: "user cancelled" } },
  { code: 4001, message: "User rejected the request." },
];

// A genuine SDK/network failure (must stay an error, not become cancellation)
const GENUINE_ERROR = { error: { type: "network", message: "rpc unavailable" } };

const unhandled: unknown[] = [];
function onUnhandled(e: PromiseRejectionEvent) {
  unhandled.push(e.reason);
}

afterEach(() => {
  window.removeEventListener("unhandledrejection", onUnhandled);
  unhandled.length = 0;
});

describe("signMessage — cancellation safety", () => {
  for (const shape of CANCELLATION_VARIANTS) {
    it("catches plain-object cancellations without leaking a rejection", async () => {
      window.addEventListener("unhandledrejection", onUnhandled);

      const provider = {
        sign: vi.fn(() => Promise.reject(shape)),
      } as unknown as Parameters<typeof signMessage>[0];

      const result = await signMessage(provider, "challenge message");

      // Must resolve to a discriminated union, never reject.
      expect(result).toHaveProperty("denied", true);
      // No unhandled rejection may escape.
      expect(unhandled).toHaveLength(0);
    });
  }

  it("treats a genuine SDK error as an error, not a cancellation", async () => {
    const provider = {
      sign: vi.fn(() => Promise.reject(GENUINE_ERROR)),
    } as unknown as Parameters<typeof signMessage>[0];

    const result = await signMessage(provider, "challenge message");
    expect(result).toHaveProperty("error");
    expect(result).not.toHaveProperty("denied");
  });

  it("handles a resolved ErrorResponse denial without rejecting", async () => {
    const provider = {
      sign: vi.fn(() =>
        Promise.resolve({
          error: { type: "denied", message: "Request rejected by user" },
        }),
      ),
    } as unknown as Parameters<typeof signMessage>[0];

    const result = await signMessage(provider, "challenge message");
    expect(result).toHaveProperty("denied", true);
  });
});

describe("sendBasicTransactionWithData — funding safety", () => {
  const transaction = {
    recipient: "NQ00 0000 0000 0000 0000 0000 0000 0000 0000",
    value: 1000,
    data: "votum:fund:test",
  };

  it("returns a normalized hash from a mocked wallet", async () => {
    const provider = {
      sendBasicTransactionWithData: vi.fn(() =>
        Promise.resolve("A".repeat(64)),
      ),
    } as unknown as Parameters<typeof sendBasicTransactionWithData>[0];

    await expect(sendBasicTransactionWithData(provider, transaction)).resolves.toEqual({
      transactionHash: "a".repeat(64),
    });
  });

  for (const shape of CANCELLATION_VARIANTS) {
    it("handles plain-object wallet cancellation without an unhandled rejection", async () => {
      window.addEventListener("unhandledrejection", onUnhandled);
      const provider = {
        sendBasicTransactionWithData: vi.fn(() => Promise.reject(shape)),
      } as unknown as Parameters<typeof sendBasicTransactionWithData>[0];

      await expect(sendBasicTransactionWithData(provider, transaction)).resolves.toEqual({
        denied: true,
      });
      expect(unhandled).toHaveLength(0);
    });
  }

  it("keeps genuine wallet errors as recoverable errors", async () => {
    const provider = {
      sendBasicTransactionWithData: vi.fn(() => Promise.reject(GENUINE_ERROR)),
    } as unknown as Parameters<typeof sendBasicTransactionWithData>[0];

    const result = await sendBasicTransactionWithData(provider, transaction);
    expect(result).toHaveProperty("error");
    expect(result).not.toHaveProperty("denied");
  });

  it("rejects malformed wallet hash callbacks", async () => {
    const provider = {
      sendBasicTransactionWithData: vi.fn(() => Promise.resolve("not-a-hash")),
    } as unknown as Parameters<typeof sendBasicTransactionWithData>[0];

    await expect(sendBasicTransactionWithData(provider, transaction)).resolves.toEqual({
      error: "Invalid transaction hash returned by wallet",
    });
  });
});
