import { describe, expect, it, vi } from "vitest";
import {
  runRewardRefund,
  type RefundDependencies,
  type RefundPreparedTransaction,
  type RefundSigningContext,
  type RewardRefundSnapshot,
  type RewardRefundStore,
} from "@/lib/rewards/refund";

const CAMPAIGN_A = "campaign-a";
const CAMPAIGN_B = "campaign-b";
const REFUND_A = "refund-a";
const REFUND_B = "refund-b";
const CREATOR_A = "01" + "a".repeat(38);
const CREATOR_B = "01" + "b".repeat(38);
const VAULT_A = "02" + "a".repeat(38);
const VAULT_B = "02" + "b".repeat(38);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PREPARED_A = "ab".repeat(32);
const PREPARED_B = "cd".repeat(32);

type FakeRefund = RewardRefundSnapshot & {
  lockKey: string;
  locked: boolean;
  broadcastStarted: boolean;
  broadcasted: boolean;
};

class FakeRefundStore implements RewardRefundStore {
  readonly refunds = new Map<string, FakeRefund>();
  readonly events: string[] = [];
  readonly locks = new Map<string, string>();

  add(refund: Partial<FakeRefund> = {}): FakeRefund {
    const value: FakeRefund = {
      refundId: refund.refundId ?? REFUND_A,
      campaignId: refund.campaignId ?? CAMPAIGN_A,
      campaignStatus: refund.campaignStatus ?? "refunding",
      creatorWallet: refund.creatorWallet ?? CREATOR_A,
      amountLuna: refund.amountLuna ?? BigInt(11200),
      status: refund.status ?? "pending",
      vaultAddressHex: refund.vaultAddressHex ?? VAULT_A,
      preparedTransactionHex: refund.preparedTransactionHex ?? null,
      preparedTransactionHash: refund.preparedTransactionHash ?? null,
      transactionHash: refund.transactionHash ?? null,
      errorCode: refund.errorCode ?? null,
      preparedFeeLuna: refund.preparedFeeLuna ?? null,
      preparedNetworkId: refund.preparedNetworkId ?? null,
      preparedValidityStartHeight: refund.preparedValidityStartHeight ?? null,
      preparedSenderAddressHex: refund.preparedSenderAddressHex ?? null,
      preparedRecipientAddressHex: refund.preparedRecipientAddressHex ?? null,
      preparedAt: refund.preparedAt ?? null,
      broadcastStartedAt: refund.broadcastStartedAt ?? null,
      broadcastAt: refund.broadcastAt ?? null,
      lockKey: refund.lockKey ?? refund.vaultAddressHex ?? VAULT_A,
      locked: false,
      broadcastStarted: false,
      broadcasted: false,
    };
    this.refunds.set(value.refundId, value);
    return value;
  }

  async loadRefund(refundId: string, campaignId: string): Promise<RewardRefundSnapshot | null> {
    const refund = this.refunds.get(refundId);
    return refund && refund.campaignId === campaignId ? refund : null;
  }

  async acquireVaultLock(campaignId: string, refundId: string, token: string): Promise<boolean> {
    const refund = this.refunds.get(refundId);
    if (!refund || refund.campaignId !== campaignId) return false;
    if (this.locks.has(refund.lockKey)) return false;
    this.locks.set(refund.lockKey, token);
    refund.locked = true;
    this.events.push(`lock:${refund.lockKey}:acquired`);
    return true;
  }

  async persistPrepared(refundId: string, prepared: RefundPreparedTransaction): Promise<void> {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error("refund_not_found");
    refund.preparedTransactionHex = prepared.serializedTransactionHex;
    refund.preparedTransactionHash = prepared.transactionHash;
    refund.preparedFeeLuna = prepared.feeLuna;
    refund.preparedNetworkId = prepared.networkId;
    refund.preparedValidityStartHeight = prepared.validityStartHeight;
    refund.preparedSenderAddressHex = prepared.senderAddressHex;
    refund.preparedRecipientAddressHex = prepared.recipientAddressHex;
    refund.preparedAt = "2026-09-12T00:00:00.000Z";
    this.events.push(`prepared:${refundId}`);
  }

  async markBroadcastStarting(refundId: string): Promise<boolean> {
    const refund = this.refunds.get(refundId);
    if (!refund || refund.broadcastStartedAt !== null || refund.broadcastAt !== null) return false;
    refund.broadcastStartedAt = "2026-09-12T00:00:01.000Z";
    refund.broadcastStarted = true;
    this.events.push(`broadcast-start:${refundId}`);
    return true;
  }

  async markBroadcastSuccess(refundId: string, transactionHash: string): Promise<void> {
    const refund = this.refunds.get(refundId);
    if (!refund || refund.preparedTransactionHash !== transactionHash) throw new Error("hash_mismatch");
    refund.transactionHash = transactionHash;
    refund.broadcastAt = "2026-09-12T00:00:02.000Z";
    refund.broadcasted = true;
    this.events.push(`broadcast-success:${refundId}`);
  }

  async recordDefiniteFailure(refundId: string, errorCode: string): Promise<void> {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error("refund_not_found");
    refund.status = "retryable";
    refund.errorCode = errorCode;
    this.events.push(`failure:${refundId}`);
  }

  async recordUnknownOutcome(refundId: string, errorCode: string): Promise<void> {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error("refund_not_found");
    refund.errorCode = errorCode;
    this.events.push(`unknown:${refundId}`);
  }

  async releaseVaultLock(_campaignId: string, refundId: string, token: string): Promise<void> {
    const refund = this.refunds.get(refundId);
    if (refund && this.locks.get(refund.lockKey) === token) {
      this.locks.delete(refund.lockKey);
      refund.locked = false;
      this.events.push(`lock:${refund.lockKey}:released`);
    }
  }
}

function prepared(
  context: RefundSigningContext,
  hash = context.senderAddressHex === VAULT_A ? HASH_A : HASH_B,
): RefundPreparedTransaction {
  return {
    ...context,
    serializedTransactionHex: context.senderAddressHex === VAULT_A ? PREPARED_A : PREPARED_B,
    transactionHash: hash,
  };
}

function dependencies(
  store: FakeRefundStore,
  overrides: Partial<RefundDependencies> = {},
): RefundDependencies {
  return {
    store,
    createLockToken: () => "refund-lock-token",
    sign: vi.fn(async (context) => prepared(context)),
    broadcast: vi.fn(async (hex) => ({
      kind: "broadcast" as const,
      transactionHash: hex === PREPARED_A ? HASH_A : HASH_B,
    })),
    getNetworkId: () => 42,
    getFeeLuna: () => BigInt(4000),
    getValidityStartHeight: async () => 100,
    sleep: async () => undefined,
    ...overrides,
  };
}

describe("prepared reward refund broadcast", () => {
  it("signs the exact frozen refund amount", async () => {
    const store = new FakeRefundStore();
    const refund = store.add({ amountLuna: BigInt(12345) });
    const deps = dependencies(store);

    await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ amountLuna: BigInt(12345) }));
  });

  it("uses the exact campaign vault as sender", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const deps = dependencies(store);

    await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ senderAddressHex: VAULT_A }));
  });

  it("uses the frozen creator wallet as recipient", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const deps = dependencies(store);

    await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ recipientAddressHex: CREATOR_A }));
  });

  it("ignores client amount and recipient overrides", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const deps = dependencies(store);

    await runRewardRefund({
      refundId: refund.refundId,
      campaignId: refund.campaignId,
      amountLuna: BigInt(1),
      recipientAddressHex: CREATOR_B,
      senderAddressHex: VAULT_B,
    } as never, deps);

    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({
      amountLuna: BigInt(11200),
      recipientAddressHex: CREATOR_A,
      senderAddressHex: VAULT_A,
    }));
  });

  it("uses server fee and network authorities", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const deps = dependencies(store, {
      getFeeLuna: () => BigInt(4000),
      getNetworkId: () => 42,
    });

    await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ feeLuna: BigInt(4000), networkId: 42 }));
  });

  it("persists the signed transaction before marking broadcast started", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();

    await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, dependencies(store));

    expect(store.events.indexOf(`prepared:${refund.refundId}`)).toBeLessThan(
      store.events.indexOf(`broadcast-start:${refund.refundId}`),
    );
  });

  it("successful broadcast persists a normalized hash", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const deps = dependencies(store, {
      broadcast: vi.fn(async () => ({ kind: "broadcast" as const, transactionHash: HASH_A.toUpperCase() })),
    });

    const result = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(result).toMatchObject({ kind: "broadcasted", transactionHash: HASH_A });
    expect(store.refunds.get(refund.refundId)?.transactionHash).toBe(HASH_A);
  });

  it("successful broadcast does not mark the refund or campaign final", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();

    const result = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, dependencies(store));

    expect(result.kind).toBe("broadcasted");
    expect(store.refunds.get(refund.refundId)?.status).toBe("pending");
    expect(store.refunds.get(refund.refundId)?.campaignStatus).toBe("refunding");
    expect(store.refunds.get(refund.refundId)?.status).not.toBe("confirmed");
    expect(store.refunds.get(refund.refundId)?.campaignStatus).not.toBe("refunded");
    expect(store.refunds.get(refund.refundId)?.campaignStatus).not.toBe("closed");
  });

  it("replays a successful refund without signing or broadcasting again", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const deps = dependencies(store);

    await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);
    const replay = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(replay.kind).toBe("already_pending");
    expect(deps.sign).toHaveBeenCalledTimes(1);
    expect(deps.broadcast).toHaveBeenCalledTimes(1);
  });

  it("does not rebroadcast a hash-bearing refund", async () => {
    const store = new FakeRefundStore();
    const refund = store.add({ transactionHash: HASH_A, preparedTransactionHash: HASH_A, broadcastStartedAt: "2026-09-12T00:00:01.000Z" });
    const deps = dependencies(store);

    const result = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(result.kind).toBe("already_pending");
    expect(deps.sign).not.toHaveBeenCalled();
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("serializes concurrent requests for the same refund", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    let broadcasts = 0;
    const deps = dependencies(store, {
      broadcast: vi.fn(async () => {
        broadcasts++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { kind: "broadcast" as const, transactionHash: HASH_A };
      }),
      sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)),
    });

    const results = await Promise.all([
      runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps),
      runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps),
    ]);

    expect(results.filter((result) => result.kind === "broadcasted")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "already_pending")).toHaveLength(1);
    expect(broadcasts).toBe(1);
  });

  it("serializes refund operations sharing one vault", async () => {
    const store = new FakeRefundStore();
    const first = store.add({ refundId: REFUND_A, campaignId: CAMPAIGN_A, vaultAddressHex: VAULT_A });
    const second = store.add({ refundId: REFUND_B, campaignId: CAMPAIGN_B, creatorWallet: CREATOR_B, vaultAddressHex: VAULT_A });
    let active = 0;
    let maximumActive = 0;
    const deps = dependencies(store, {
      broadcast: vi.fn(async (hex) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { kind: "broadcast" as const, transactionHash: hex === PREPARED_A ? HASH_A : HASH_B };
      }),
      sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)),
    });

    const results = await Promise.all([
      runRewardRefund({ refundId: first.refundId, campaignId: first.campaignId }, deps),
      runRewardRefund({ refundId: second.refundId, campaignId: second.campaignId }, deps),
    ]);

    expect(results.every((result) => result.kind === "broadcasted")).toBe(true);
    expect(maximumActive).toBe(1);
  });

  it("allows different vaults to proceed independently", async () => {
    const store = new FakeRefundStore();
    const first = store.add({ refundId: REFUND_A, campaignId: CAMPAIGN_A, vaultAddressHex: VAULT_A });
    const second = store.add({ refundId: REFUND_B, campaignId: CAMPAIGN_B, creatorWallet: CREATOR_B, vaultAddressHex: VAULT_B });
    let active = 0;
    let maximumActive = 0;
    const deps = dependencies(store, {
      broadcast: vi.fn(async (hex) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { kind: "broadcast" as const, transactionHash: hex === PREPARED_A ? HASH_A : HASH_B };
      }),
    });

    await Promise.all([
      runRewardRefund({ refundId: first.refundId, campaignId: first.campaignId }, deps),
      runRewardRefund({ refundId: second.refundId, campaignId: second.campaignId }, deps),
    ]);

    expect(maximumActive).toBe(2);
  });

  it("returns busy when the payout lock already owns the vault", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    store.locks.set(VAULT_A, "payout-lock");
    const deps = dependencies(store, { sleep: async () => undefined });

    const result = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(result.kind).toBe("busy");
    expect(deps.sign).not.toHaveBeenCalled();
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("leaves a recoverable state on vault decrypt failure", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const deps = dependencies(store, { sign: vi.fn(async () => { throw new Error("vault_decrypt_failed"); }) });

    const result = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(result.kind).toBe("retryable");
    expect(store.refunds.get(refund.refundId)).toMatchObject({ status: "retryable", transactionHash: null });
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("leaves no hash on signing failure", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const deps = dependencies(store, { sign: vi.fn(async () => { throw new Error("signing_failed"); }) });

    await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(store.refunds.get(refund.refundId)?.transactionHash).toBeNull();
    expect(store.refunds.get(refund.refundId)?.preparedTransactionHash).toBeNull();
  });

  it("allows a definite pre-broadcast failure to recover safely", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const sign = vi.fn()
      .mockRejectedValueOnce(new Error("construction_failed"))
      .mockImplementation(async (context: RefundSigningContext) => prepared(context));
    const deps = dependencies(store, { sign });

    const first = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);
    const second = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(first.kind).toBe("retryable");
    expect(second.kind).toBe("broadcasted");
    expect(deps.broadcast).toHaveBeenCalledTimes(1);
  });

  it("does not blindly resend after an unknown broadcast result", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const broadcast = vi.fn(async () => ({ kind: "unknown" as const, errorCode: "broadcast_timeout" }));
    const deps = dependencies(store, { broadcast });

    const first = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);
    const second = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(first.kind).toBe("unknown");
    expect(second.kind).toBe("unknown");
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("treats a node rejection after the broadcast boundary as unknown", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const broadcast = vi.fn(async () => ({
      kind: "definitely_not_broadcast" as const,
      errorCode: "broadcast_rejected",
    }));
    const deps = dependencies(store, { broadcast });

    const first = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);
    const second = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(first.kind).toBe("unknown");
    expect(second.kind).toBe("unknown");
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(store.refunds.get(refund.refundId)).toMatchObject({ status: "pending", transactionHash: null });
  });

  it("fails safely on a malformed broadcast response", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const deps = dependencies(store, {
      broadcast: vi.fn(async () => ({ kind: "malformed" as const, errorCode: "broadcast_response_malformed" })),
    });

    const result = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(result.kind).toBe("unknown");
    expect(store.refunds.get(refund.refundId)?.transactionHash).toBeNull();
    expect(store.refunds.get(refund.refundId)?.broadcastStartedAt).not.toBeNull();
  });

  it("rejects a non-refunding campaign before signing", async () => {
    const store = new FakeRefundStore();
    const refund = store.add({ campaignStatus: "closed" });
    const deps = dependencies(store);

    const result = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(result).toMatchObject({ kind: "rejected", reasonCode: "campaign_not_refunding" });
    expect(deps.sign).not.toHaveBeenCalled();
  });

  it("does not create receipts, payout rows, or option data", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const deps = dependencies(store);

    const result = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toMatch(/receipt|payout|option|selected/i);
    expect(store.refunds.size).toBe(1);
  });

  it("does not expose private key or envelope material", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const result = await runRewardRefund(
      { refundId: refund.refundId, campaignId: refund.campaignId },
      dependencies(store),
    );

    expect(JSON.stringify(result)).not.toMatch(/private|cipher|envelope|master|signed.?transaction/i);
  });

  it("does not create a second refund intent", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const deps = dependencies(store);

    await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);
    await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(store.refunds.size).toBe(1);
  });

  it("reuses a prepared signed transaction without signing again", async () => {
    const store = new FakeRefundStore();
    const refund = store.add({
      preparedTransactionHex: PREPARED_A,
      preparedTransactionHash: HASH_A,
      preparedFeeLuna: BigInt(4000),
      preparedNetworkId: 42,
      preparedValidityStartHeight: 100,
      preparedSenderAddressHex: VAULT_A,
      preparedRecipientAddressHex: CREATOR_A,
      preparedAt: "2026-09-12T00:00:00.000Z",
    });
    const deps = dependencies(store);

    const result = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(result.kind).toBe("broadcasted");
    expect(deps.sign).not.toHaveBeenCalled();
    expect(deps.broadcast).toHaveBeenCalledTimes(1);
  });

  it("does not mark a refund or campaign final after broadcast", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, dependencies(store));

    expect(store.refunds.get(refund.refundId)?.status).toBe("pending");
    expect(store.refunds.get(refund.refundId)?.campaignStatus).toBe("refunding");
  });

  it("normalizes and validates the signer output before persistence", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const deps = dependencies(store, {
      sign: vi.fn(async (context) => ({
        ...prepared(context),
        transactionHash: HASH_A.toUpperCase(),
      })),
    });

    const result = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(result.kind).toBe("broadcasted");
    expect(store.refunds.get(refund.refundId)?.preparedTransactionHash).toBe(HASH_A);
  });

  it("rejects malformed signer output without broadcasting", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const deps = dependencies(store, {
      sign: vi.fn(async (context) => ({ ...prepared(context), transactionHash: "not-a-hash" })),
    });

    const result = await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(result.kind).toBe("retryable");
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("retains refunding state when the network returns an unknown outcome", async () => {
    const store = new FakeRefundStore();
    const refund = store.add();
    const deps = dependencies(store, {
      broadcast: vi.fn(async () => ({ kind: "unknown" as const, errorCode: "broadcast_unavailable" })),
    });

    await runRewardRefund({ refundId: refund.refundId, campaignId: refund.campaignId }, deps);

    expect(store.refunds.get(refund.refundId)?.campaignStatus).toBe("refunding");
    expect(store.refunds.get(refund.refundId)?.status).toBe("pending");
  });
});
