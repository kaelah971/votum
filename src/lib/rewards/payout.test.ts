import { describe, expect, it, vi } from "vitest";
import {
  runRewardPayout,
  type PayoutClaim,
  type PayoutAttemptSnapshot,
  type PayoutDependencies,
  type PayoutPreparedTransaction,
  type RewardPayoutStore,
} from "@/lib/rewards/payout";

const CAMPAIGN_A = "campaign-a";
const CAMPAIGN_B = "campaign-b";
const RECEIPT_A = "receipt-a";
const RECEIPT_B = "receipt-b";
const WALLET_A = "01" + "a".repeat(38);
const WALLET_B = "01" + "b".repeat(38);
const VAULT_A = "02" + "a".repeat(38);
const VAULT_B = "02" + "b".repeat(38);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

type FakeAttempt = {
  attemptId: string;
  receiptId: string;
  campaignId: string;
  status: "pending" | "confirmed" | "failed" | "retryable";
  transactionHash: string | null;
  preparedTransactionHex: string | null;
  broadcastStarted: boolean;
  broadcasted: boolean;
  errorCode: string | null;
  preparedFeeLuna: bigint | null;
  preparedNetworkId: number | null;
  preparedValidityStartHeight: number | null;
  preparedSenderAddressHex: string | null;
  preparedRecipientAddressHex: string | null;
};

type FakeReceipt = {
  receiptId: string;
  campaignId: string;
  status: "reserved" | "payout_pending" | "paid" | "failed" | "retryable";
  participantWallet: string;
  amountLuna: bigint;
  vaultAddressHex: string;
};

class FakePayoutStore implements RewardPayoutStore {
  readonly receipts = new Map<string, FakeReceipt>();
  readonly attempts = new Map<string, FakeAttempt>();
  readonly refunds: string[] = [];
  readonly events: string[] = [];
  readonly locks = new Map<string, string>();
  private attemptSequence = 0;

  addReceipt(receipt: FakeReceipt): void {
    this.receipts.set(receipt.receiptId, receipt);
  }

  async beginPayoutAtomic(receiptId: string, campaignId: string): Promise<PayoutClaim> {
    const receipt = this.receipts.get(receiptId);
    if (!receipt || receipt.campaignId !== campaignId) {
      return { kind: "rejected", reasonCode: "receipt_not_found" };
    }
    const existing = [...this.attempts.values()].find((attempt) => attempt.receiptId === receiptId);
    if (receipt.status === "paid") return { kind: "rejected", reasonCode: "receipt_paid" };
    if (receipt.status === "failed" || receipt.status === "retryable") {
      return { kind: "rejected", reasonCode: `receipt_state_${receipt.status}` };
    }
    if (existing) {
      return this.claim(receipt, existing, "replay");
    }
    if (receipt.status !== "reserved") {
      return { kind: "rejected", reasonCode: "receipt_not_reserved" };
    }
    const attempt: FakeAttempt = {
      attemptId: `attempt-${++this.attemptSequence}`,
      receiptId,
      campaignId,
      status: "pending",
      transactionHash: null,
      preparedTransactionHex: null,
      broadcastStarted: false,
      broadcasted: false,
      errorCode: null,
      preparedFeeLuna: null,
      preparedNetworkId: null,
      preparedValidityStartHeight: null,
      preparedSenderAddressHex: null,
      preparedRecipientAddressHex: null,
    };
    this.attempts.set(attempt.attemptId, attempt);
    receipt.status = "payout_pending";
    return this.claim(receipt, attempt, "claimed");
  }

  private claim(receipt: FakeReceipt, attempt: FakeAttempt, kind: "claimed" | "replay"): PayoutClaim {
    return {
      kind,
      attempt: {
        attemptId: attempt.attemptId,
        receiptId: receipt.receiptId,
        campaignId: receipt.campaignId,
        attemptNumber: 1,
        attemptStatus: attempt.status,
        receiptStatus: receipt.status,
        participantWallet: receipt.participantWallet,
        amountLuna: receipt.amountLuna,
        vaultAddressHex: receipt.vaultAddressHex,
        preparedTransactionHex: attempt.preparedTransactionHex,
        transactionHash: attempt.transactionHash,
        preparedFeeLuna: attempt.preparedFeeLuna,
        preparedNetworkId: attempt.preparedNetworkId,
        preparedValidityStartHeight: attempt.preparedValidityStartHeight,
        preparedSenderAddressHex: attempt.preparedSenderAddressHex,
        preparedRecipientAddressHex: attempt.preparedRecipientAddressHex,
        broadcastStartedAt: attempt.broadcastStarted ? "2026-09-12T00:00:00.000Z" : null,
        broadcastAt: attempt.broadcasted ? "2026-09-12T00:00:01.000Z" : null,
      },
    };
  }

  async acquireVaultLock(campaignId: string, _attemptId: string, token: string): Promise<boolean> {
    if (this.locks.has(campaignId)) return false;
    this.locks.set(campaignId, token);
    this.events.push(`lock:${campaignId}:acquired`);
    return true;
  }

  async loadPayoutAttempt(attemptId: string): Promise<PayoutAttemptSnapshot | null> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return null;
    const receipt = this.receipts.get(attempt.receiptId);
    if (!receipt) return null;
    const claim = this.claim(receipt, attempt, "replay");
    return claim.kind === "claimed" || claim.kind === "replay" ? claim.attempt : null;
  }

  async persistPrepared(attemptId: string, prepared: PayoutPreparedTransaction): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error("attempt_not_found");
    attempt.preparedTransactionHex = prepared.serializedTransactionHex;
    attempt.transactionHash = prepared.transactionHash;
    attempt.preparedFeeLuna = prepared.feeLuna;
    attempt.preparedNetworkId = prepared.networkId;
    attempt.preparedValidityStartHeight = prepared.validityStartHeight;
    attempt.preparedSenderAddressHex = prepared.senderAddressHex;
    attempt.preparedRecipientAddressHex = prepared.recipientAddressHex;
    this.events.push(`prepared:${attemptId}`);
  }

  async markBroadcastStarting(attemptId: string): Promise<boolean> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.broadcastStarted || attempt.broadcasted) return false;
    attempt.broadcastStarted = true;
    this.events.push(`broadcast-start:${attemptId}`);
    return true;
  }

  async markBroadcastSuccess(attemptId: string, transactionHash: string): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.transactionHash !== transactionHash) throw new Error("hash_mismatch");
    attempt.broadcasted = true;
    this.events.push(`broadcast-success:${attemptId}`);
  }

  async recordDefiniteFailure(attemptId: string, errorCode: string): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error("attempt_not_found");
    attempt.status = "retryable";
    attempt.errorCode = errorCode;
    const receipt = this.receipts.get(attempt.receiptId);
    if (receipt) receipt.status = "retryable";
    this.events.push(`failure:${attemptId}`);
  }

  async recordUnknownOutcome(attemptId: string, errorCode: string): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error("attempt_not_found");
    attempt.errorCode = errorCode;
    this.events.push(`unknown:${attemptId}`);
  }

  async releaseVaultLock(campaignId: string, token: string): Promise<void> {
    if (this.locks.get(campaignId) === token) {
      this.locks.delete(campaignId);
      this.events.push(`lock:${campaignId}:released`);
    }
  }

  attemptFor(receiptId: string): FakeAttempt | undefined {
    return [...this.attempts.values()].find((attempt) => attempt.receiptId === receiptId);
  }
}

function receipt(overrides: Partial<FakeReceipt> = {}): FakeReceipt {
  return {
    receiptId: RECEIPT_A,
    campaignId: CAMPAIGN_A,
    status: "reserved",
    participantWallet: WALLET_A,
    amountLuna: BigInt(7500),
    vaultAddressHex: VAULT_A,
    ...overrides,
  };
}

function prepared(hash: string = HASH_A): PayoutPreparedTransaction {
  return {
    campaignId: CAMPAIGN_A,
    attemptId: "attempt-1",
    senderAddressHex: VAULT_A,
    recipientAddressHex: WALLET_A,
    amountLuna: BigInt(7500),
    feeLuna: BigInt(4000),
    networkId: 42,
    validityStartHeight: 100,
    serializedTransactionHex: "ab".repeat(16),
    transactionHash: hash,
  };
}

function preparedFor(
  context: { campaignId: string; attemptId: string; senderAddressHex: string; recipientAddressHex: string; amountLuna: bigint; feeLuna: bigint; networkId: number; validityStartHeight: number },
  hash: string = HASH_A,
): PayoutPreparedTransaction {
  return {
    ...context,
    serializedTransactionHex: context.recipientAddressHex === WALLET_A ? "ab".repeat(16) : "cd".repeat(16),
    transactionHash: hash,
  };
}

function dependencies(
  store: FakePayoutStore,
  overrides: Partial<PayoutDependencies> = {},
): PayoutDependencies {
  return {
    store,
    createLockToken: () => "lock-token",
    sign: vi.fn(async (context) => preparedFor(
      context,
      context.recipientAddressHex === WALLET_A ? HASH_A : HASH_B,
    )),
    broadcast: vi.fn(async (serializedTransactionHex) => ({
      kind: "broadcast" as const,
      transactionHash: serializedTransactionHex === "ab".repeat(16) ? HASH_A : HASH_B,
    })),
    getNetworkId: () => 42,
    getValidityStartHeight: async () => 100,
    sleep: async () => undefined,
    ...overrides,
  };
}

function addTwoReceipts(store: FakePayoutStore): void {
  store.addReceipt(receipt());
  store.addReceipt(receipt({
    receiptId: RECEIPT_B,
    participantWallet: WALLET_B,
  }));
}

describe("automatic reserved reward payout", () => {
  it("creates one attempt from a reserved receipt and transitions to payout_pending", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    const result = await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, dependencies(store));

    expect(result.kind).toBe("broadcasted");
    expect(store.receipts.get(RECEIPT_A)?.status).toBe("payout_pending");
    expect(store.attempts.size).toBe(1);
  });

  it("takes amount only from the authoritative receipt", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt({ amountLuna: BigInt(12345) }));
    const sign = vi.fn(async (context) => {
      expect(context.amountLuna).toBe(BigInt(12345));
      return preparedFor({ ...context, amountLuna: BigInt(12345) });
    });
    await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, dependencies(store, { sign }));
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("takes recipient only from the authoritative receipt", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt({ participantWallet: WALLET_B }));
    const sign = vi.fn(async (context) => {
      expect(context.recipientAddressHex).toBe(WALLET_B);
      return preparedFor({ ...context, recipientAddressHex: WALLET_B });
    });
    await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, dependencies(store, { sign }));
  });

  it("uses the isolated vault belonging to the receipt campaign", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt({ vaultAddressHex: VAULT_B }));
    const sign = vi.fn(async (context) => {
      expect(context.senderAddressHex).toBe(VAULT_B);
      return preparedFor({ ...context, senderAddressHex: VAULT_B });
    });
    await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, dependencies(store, { sign }));
  });

  it("ignores browser-supplied amount and destination fields", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    const sign = vi.fn(async (context) => {
      expect(context.amountLuna).toBe(BigInt(7500));
      expect(context.recipientAddressHex).toBe(WALLET_A);
      return preparedFor(context);
    });
    await runRewardPayout({
      receiptId: RECEIPT_A,
      campaignId: CAMPAIGN_A,
      amountLuna: BigInt(1),
      recipientAddressHex: WALLET_B,
    } as never, dependencies(store, { sign }));
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("persists prepared transaction data before starting broadcast", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, dependencies(store));
    expect(store.events.indexOf("prepared:attempt-1")).toBeLessThan(
      store.events.indexOf("broadcast-start:attempt-1"),
    );
  });

  it("successful broadcast stores its normalized hash and does not mark paid", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    const result = await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, dependencies(store));
    expect(result).toMatchObject({ kind: "broadcasted", transactionHash: HASH_A });
    expect(store.attemptFor(RECEIPT_A)?.transactionHash).toBe(HASH_A);
    expect(store.receipts.get(RECEIPT_A)?.status).toBe("payout_pending");
    expect(store.receipts.get(RECEIPT_A)?.status).not.toBe("paid");
  });

  it("replays an existing attempt without creating a second attempt", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    const deps = dependencies(store);
    await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps);
    const result = await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps);
    expect(result.kind).toBe("already_pending");
    expect(store.attempts.size).toBe(1);
  });

  it("does not sign or broadcast a prepared attempt twice", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    const deps = dependencies(store);
    await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps);
    await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps);
    expect(deps.sign).toHaveBeenCalledTimes(1);
    expect(deps.broadcast).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent requests for the same receipt", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    const deps = dependencies(store);
    const results = await Promise.all([
      runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps),
      runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps),
    ]);
    expect(results.filter((result) => result.kind === "broadcasted")).toHaveLength(1);
    expect(store.attempts.size).toBe(1);
    expect(deps.broadcast).toHaveBeenCalledTimes(1);
  });

  it("serializes two receipts sharing one vault", async () => {
    const store = new FakePayoutStore();
    addTwoReceipts(store);
    let activeBroadcasts = 0;
    let maximumActiveBroadcasts = 0;
    const deps = dependencies(store, {
      broadcast: vi.fn(async (hex) => {
        activeBroadcasts++;
        maximumActiveBroadcasts = Math.max(maximumActiveBroadcasts, activeBroadcasts);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeBroadcasts--;
        return { kind: "broadcast" as const, transactionHash: hex === "ab".repeat(16) ? HASH_A : HASH_B };
      }),
      sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)),
    });
    const results = await Promise.all([
      runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps),
      runRewardPayout({ receiptId: RECEIPT_B, campaignId: CAMPAIGN_A }, deps),
    ]);
    expect(results.every((result) => result.kind === "broadcasted")).toBe(true);
    expect(maximumActiveBroadcasts).toBe(1);
  });

  it("allows independent vaults to proceed concurrently", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    store.addReceipt(receipt({ receiptId: RECEIPT_B, campaignId: CAMPAIGN_B, vaultAddressHex: VAULT_B }));
    let activeBroadcasts = 0;
    let maximumActiveBroadcasts = 0;
    const deps = dependencies(store, {
      broadcast: vi.fn(async (hex) => {
        activeBroadcasts++;
        maximumActiveBroadcasts = Math.max(maximumActiveBroadcasts, activeBroadcasts);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeBroadcasts--;
        return { kind: "broadcast" as const, transactionHash: hex === "ab".repeat(16) ? HASH_A : HASH_B };
      }),
    });
    await Promise.all([
      runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps),
      runRewardPayout({ receiptId: RECEIPT_B, campaignId: CAMPAIGN_B }, deps),
    ]);
    expect(maximumActiveBroadcasts).toBe(2);
  });

  it("leaves a recoverable durable state on signing failure", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    const deps = dependencies(store, { sign: vi.fn(async () => { throw new Error("signing_failed"); }) });
    const result = await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps);
    expect(result.kind).toBe("retryable");
    expect(store.attemptFor(RECEIPT_A)).toMatchObject({ status: "retryable", transactionHash: null });
    expect(store.receipts.get(RECEIPT_A)?.status).toBe("retryable");
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("does not fabricate a hash for a definite pre-broadcast failure", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    const deps = dependencies(store, { sign: vi.fn(async () => { throw new Error("key_unavailable"); }) });
    await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps);
    expect(store.attemptFor(RECEIPT_A)?.transactionHash).toBeNull();
  });

  it("does not resend after an unknown broadcast outcome", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    const broadcast = vi.fn(async () => ({ kind: "unknown" as const, errorCode: "broadcast_timeout" }));
    const deps = dependencies(store, { broadcast });
    const first = await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps);
    const second = await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps);
    expect(first.kind).toBe("unknown");
    expect(second.kind).toBe("already_pending");
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("fails safely on a malformed broadcast response", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    const deps = dependencies(store, {
      broadcast: vi.fn(async () => ({ kind: "malformed" as const, errorCode: "broadcast_response_malformed" })),
    });
    const result = await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps);
    expect(result.kind).toBe("unknown");
    expect(store.receipts.get(RECEIPT_A)?.status).toBe("payout_pending");
  });

  it("never uses selected-option data in the payout context", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    const sign = vi.fn(async (context) => {
      expect(Object.keys(context)).not.toContain("optionId");
      expect(Object.keys(context)).not.toContain("selectedOption");
      return prepared();
    });
    await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, dependencies(store, { sign }));
  });

  it("passes Luna values as bigint and never as floating point", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt({ amountLuna: BigInt(9007199254740990) }));
    const sign = vi.fn(async (context) => {
      expect(typeof context.amountLuna).toBe("bigint");
      expect(typeof context.feeLuna).toBe("bigint");
      return { ...prepared(), amountLuna: context.amountLuna };
    });
    await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, dependencies(store, { sign }));
  });

  it("does not return private key, envelope, or signed transaction material", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    const result = await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, dependencies(store));
    const output = JSON.stringify(result);
    expect(output).not.toMatch(/private|master|cipher|envelope|signed-transaction-hex/i);
  });

  it("does not start a fresh payout for payout_pending", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt({ status: "payout_pending" }));
    const existing = await store.beginPayoutAtomic(RECEIPT_A, CAMPAIGN_A);
    expect(existing.kind).toBe("rejected");
    const deps = dependencies(store);
    const result = await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps);
    expect(result.kind).toBe("rejected");
    expect(deps.sign).not.toHaveBeenCalled();
  });

  it("does not initiate payout for a paid receipt", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt({ status: "paid" }));
    const deps = dependencies(store);
    const result = await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps);
    expect(result.kind).toBe("rejected");
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("leaves failed and retryable lifecycle states to the existing retry path", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt({ status: "retryable" }));
    const deps = dependencies(store);
    const result = await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, deps);
    expect(result.kind).toBe("rejected");
    expect(deps.sign).not.toHaveBeenCalled();
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("does not create refund rows", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, dependencies(store));
    expect(store.refunds).toHaveLength(0);
  });

  it("uses the server fee and network authorities", async () => {
    const store = new FakePayoutStore();
    store.addReceipt(receipt());
    const sign = vi.fn(async (context) => {
      expect(context.feeLuna).toBe(BigInt(4000));
      expect(context.networkId).toBe(42);
      return prepared();
    });
    await runRewardPayout({ receiptId: RECEIPT_A, campaignId: CAMPAIGN_A }, dependencies(store, { sign }));
  });
});
