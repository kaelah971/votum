import { describe, expect, it, vi } from "vitest";
import {
  PollRewardClosureAdapter,
  type PollClosureSource,
  type PollClosureSourceStore,
} from "@/lib/rewards/poll-closure-adapter";

const POLL_ID = "poll-1";
const SETTLEMENT_ID = "settlement-1";
const OWNER = "01" + "a".repeat(38);

function source(overrides: Partial<PollClosureSource> = {}): PollClosureSource {
  return {
    pollId: POLL_ID,
    pollStatus: "closed",
    endsAt: "2026-09-13T01:00:00.000Z",
    creatorWallet: OWNER,
    settlementId: SETTLEMENT_ID,
    bindingSourceId: POLL_ID,
    ...overrides,
  };
}

function adapter(value: PollClosureSource = source()) {
  const store: PollClosureSourceStore = {
    load: vi.fn(async () => value),
  };
  return { adapter: new PollRewardClosureAdapter(store), store };
}

describe("PollRewardClosureAdapter", () => {
  it("maps a closed Poll to a source-neutral source_closed trigger", async () => {
    const result = await adapter().adapter.resolveClosureContext(POLL_ID, OWNER);

    expect(result).toMatchObject({
      kind: "ready",
      context: {
        trigger: {
          source: { type: "poll_vote", id: POLL_ID },
          settlement: {
            id: SETTLEMENT_ID,
            binding: { sourceType: "poll_vote", sourceId: POLL_ID },
          },
          reason: "source_closed",
        },
      },
    });
  });

  it("maps an elapsed live Poll to the elapsed neutral trigger", async () => {
    const { adapter: closureAdapter } = adapter(source({
      pollStatus: "live",
      endsAt: "2020-01-01T00:00:00.000Z",
    }));

    await expect(closureAdapter.resolveClosureContext(POLL_ID, OWNER)).resolves.toMatchObject({
      kind: "ready",
      context: { trigger: { reason: "elapsed" } },
    });
  });

  it("does not create a trigger for an active unelapsed Poll", async () => {
    const { adapter: closureAdapter } = adapter(source({
      pollStatus: "live",
      endsAt: "2999-01-01T00:00:00.000Z",
    }));

    await expect(closureAdapter.resolveClosureContext(POLL_ID, OWNER)).resolves.toEqual({
      kind: "not_closed",
      reasonCode: "participation_window_open",
    });
  });

  it("maps a cancelled Poll to the creator_cancelled neutral trigger", async () => {
    const { adapter: closureAdapter } = adapter(source({ pollStatus: "cancelled" }));

    await expect(closureAdapter.resolveClosureContext(POLL_ID, OWNER)).resolves.toMatchObject({
      kind: "ready",
      context: { trigger: { reason: "creator_cancelled" } },
    });
  });

  it("creates observedAt on the server and excludes financial or authorization fields", async () => {
    const result = await adapter().adapter.resolveClosureContext(POLL_ID, OWNER);

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(Number.isNaN(Date.parse(result.context.trigger.observedAt))).toBe(false);
    expect(Object.keys(result.context)).toEqual(["trigger"]);
    expect(JSON.stringify(result.context)).not.toMatch(
      /amount|balance|obligation|vault|session|token|status|selectedOption|optionId/i,
    );
  });

  it("checks creator authorization separately from the trigger", async () => {
    const result = await adapter().adapter.resolveClosureContext(POLL_ID, "02" + "b".repeat(38));

    expect(result).toEqual({ kind: "forbidden" });
  });

  it("fails closed for a Poll/source binding mismatch", async () => {
    const { adapter: closureAdapter } = adapter(source({ pollId: "other-poll" }));

    await expect(closureAdapter.resolveClosureContext(POLL_ID, OWNER)).resolves.toEqual({
      kind: "error",
      reasonCode: "malformed_source_binding",
    });
  });

  it("revalidates the current source and settlement binding", async () => {
    const { adapter: closureAdapter, store } = adapter();
    const ready = await closureAdapter.resolveClosureContext(POLL_ID, OWNER);
    if (ready.kind !== "ready") throw new Error("expected trigger");

    await expect(closureAdapter.revalidateTrigger(ready.context.trigger)).resolves.toBe(true);
    expect(store.load).toHaveBeenCalledWith(POLL_ID);
  });
});
