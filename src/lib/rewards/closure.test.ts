import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createRewardClosureService,
  createSupabaseRewardClosureService,
  type RewardClosureContext,
  type RewardClosureStore,
} from "@/lib/rewards/closure";

const SETTLEMENT_ID = "settlement-1";
const REFUND_ID = "refund-1";
const SESSION_HASH = "session-hash";

function context(overrides: Partial<RewardClosureContext> = {}): RewardClosureContext {
  return {
    trigger: {
      source: { type: "poll_vote", id: "poll-1" },
      settlement: {
        id: SETTLEMENT_ID,
        binding: { sourceType: "poll_vote", sourceId: "poll-1" },
      },
      reason: "source_closed",
      observedAt: "2026-09-13T00:00:00.000Z",
    },
    ...overrides,
  };
}

function store(raw: unknown = {
  result_kind: "created",
  campaign_id: SETTLEMENT_ID,
  refund_id: REFUND_ID,
}) {
  const value: RewardClosureStore = {
    revalidateTrigger: vi.fn(async () => true),
    beginRefund: vi.fn(async () => raw),
  };
  return value;
}

describe("RewardClosureService", () => {
  it("accepts only the source-neutral trigger and a separate authorization", async () => {
    const closureStore = store();
    const service = createRewardClosureService(closureStore, vi.fn(async () => ({
      kind: "broadcasted" as const,
      refundId: REFUND_ID,
      transactionHash: "a".repeat(64),
    })));

    await service.prepareRefund(context(), { sessionTokenHash: SESSION_HASH });

    expect(closureStore.revalidateTrigger).toHaveBeenCalledWith(context().trigger);
    expect(closureStore.beginRefund).toHaveBeenCalledWith(SETTLEMENT_ID, SESSION_HASH);
    expect(JSON.stringify(context())).not.toMatch(/amount|balance|obligation|vault|session|token/i);
  });

  it("revalidates source/binding identity before preparing a refund", async () => {
    const closureStore = store();
    vi.mocked(closureStore.revalidateTrigger).mockResolvedValue(false);
    const service = createRewardClosureService(closureStore, vi.fn());

    await expect(service.prepareRefund(context(), { sessionTokenHash: SESSION_HASH })).resolves.toEqual({
      kind: "error",
      reasonCode: "source_trigger_stale",
    });
    expect(closureStore.beginRefund).not.toHaveBeenCalled();
  });

  it("passes session authorization only to the existing Poll-bound refund RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: { result_kind: "created", campaign_id: SETTLEMENT_ID, refund_id: REFUND_ID },
      error: null,
    }));
    const service = createSupabaseRewardClosureService({ rpc } as never, async () => true);

    await expect(service.prepareRefund(context(), { sessionTokenHash: SESSION_HASH })).resolves.toEqual({
      kind: "created",
      settlementId: SETTLEMENT_ID,
      refundId: REFUND_ID,
    });
    expect(rpc).toHaveBeenCalledWith("begin_reward_refund_atomic", {
      _campaign_id: SETTLEMENT_ID,
      _session_token_hash: SESSION_HASH,
    });
  });

  it("keeps blocked, zero-refund, replay, and malformed results safe", async () => {
    for (const raw of [
      { result_kind: "unresolved_reward_obligations", campaign_id: SETTLEMENT_ID },
      { result_kind: "nothing_to_refund", campaign_id: SETTLEMENT_ID },
      { result_kind: "already_refunded_or_closed", campaign_id: SETTLEMENT_ID },
      { result_kind: "created", campaign_id: "other-settlement", refund_id: REFUND_ID },
      null,
    ]) {
      const closureStore = store(raw);
      const service = createRewardClosureService(closureStore, vi.fn());
      const result = await service.prepareRefund(context(), { sessionTokenHash: SESSION_HASH });
      expect(result.kind).toBe(raw?.result_kind === "nothing_to_refund"
        ? "nothing_to_refund"
        : raw?.result_kind === "already_refunded_or_closed"
          ? "already_refunded_or_closed"
          : raw?.result_kind === "created" && raw.campaign_id === SETTLEMENT_ID
            ? "created"
            : "error");
    }
  });

  it("delegates refund execution without signing or broadcasting in the closure layer", async () => {
    const executeRefund = vi.fn(async () => ({
      kind: "broadcasted" as const,
      refundId: REFUND_ID,
      transactionHash: "a".repeat(64),
    }));
    const service = createRewardClosureService(store(), executeRefund);

    await expect(service.executeRefund(SETTLEMENT_ID, REFUND_ID)).resolves.toMatchObject({ kind: "broadcasted" });
    expect(executeRefund).toHaveBeenCalledWith(SETTLEMENT_ID, REFUND_ID);
  });

  it("rejects a context that contains client financial fields", async () => {
    const closureStore = store();
    const service = createRewardClosureService(closureStore, vi.fn());
    const invalid = {
      ...context(),
      amountLuna: BigInt(1),
      vaultAddressHex: "client-vault",
    } as RewardClosureContext;

    await expect(service.prepareRefund(invalid, { sessionTokenHash: SESSION_HASH })).resolves.toEqual({
      kind: "error",
      reasonCode: "invalid_closure_context",
    });
    expect(closureStore.beginRefund).not.toHaveBeenCalled();
  });

  it("keeps Poll lifecycle in the adapter and ignores the refund request body", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/app/api/polls/[pollId]/reward/refund/route.ts"),
      "utf8",
    );

    expect(source).toContain("PollRewardClosureAdapter");
    expect(source).toContain("createSupabaseRewardClosureService");
    expect(source).not.toContain("request.json");
  });
});
