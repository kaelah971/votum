import { describe, expect, it, vi } from "vitest";
import {
  CampaignRewardClosureAdapter,
  type CampaignClosureSourceStore,
} from "@/lib/campaigns/campaign-closure-adapter";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const SETTLEMENT = "44444444-4444-4444-8444-444444444444";
const OWNER = "01" + "a".repeat(38);
const OTHER = "02" + "b".repeat(38);
const NOW = new Date("2026-09-17T12:00:00.000Z");

function source(overrides: Record<string, unknown> = {}) {
  return {
    campaignId: CAMPAIGN,
    campaignType: "public_giveaway",
    campaignStatus: "closed",
    endsAt: null,
    creatorWallet: OWNER,
    settlementId: SETTLEMENT,
    bindingSourceId: CAMPAIGN,
    ...overrides,
  };
}

function store(overrides: Partial<CampaignClosureSourceStore> = {}) {
  return {
    load: vi.fn(async () => source()),
    ...overrides,
  } as CampaignClosureSourceStore;
}

describe("CampaignRewardClosureAdapter", () => {
  it("resolves a closed Campaign into a source_closed trigger", async () => {
    const adapter = new CampaignRewardClosureAdapter(store(), () => NOW);
    const result = await adapter.resolveClosureContext(CAMPAIGN, OWNER);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("expected ready context");
    expect(result.context.trigger).toMatchObject({
      source: { type: "campaign_claim", id: CAMPAIGN },
      settlement: {
        id: SETTLEMENT,
        binding: { sourceType: "campaign_claim", sourceId: CAMPAIGN },
      },
      reason: "source_closed",
    });
    expect(JSON.stringify(result.context)).not.toMatch(/amount|vault|refundable/i);
  });

  it("resolves elapsed windows and creator cancellation", async () => {
    const elapsed = new CampaignRewardClosureAdapter(
      store({ load: vi.fn(async () => source({ campaignStatus: "published", endsAt: "2026-09-17T11:00:00.000Z" })) }),
      () => NOW,
    );
    const elapsedResult = await elapsed.resolveClosureContext(CAMPAIGN, OWNER);
    expect(elapsedResult.kind).toBe("ready");
    if (elapsedResult.kind === "ready") {
      expect(elapsedResult.context.trigger.reason).toBe("elapsed");
    }

    const cancelled = new CampaignRewardClosureAdapter(
      store({ load: vi.fn(async () => source({ campaignStatus: "cancelled" })) }),
      () => NOW,
    );
    const cancelledResult = await cancelled.resolveClosureContext(CAMPAIGN, OWNER);
    expect(cancelledResult.kind).toBe("ready");
    if (cancelledResult.kind === "ready") {
      expect(cancelledResult.context.trigger.reason).toBe("creator_cancelled");
    }
  });

  it("rejects unknown, open, forbidden, and malformed sources", async () => {
    const missing = new CampaignRewardClosureAdapter(
      store({ load: vi.fn(async () => null) }), () => NOW,
    );
    await expect(missing.resolveClosureContext(CAMPAIGN, OWNER)).resolves.toMatchObject({
      kind: "not_found",
      reasonCode: "campaign_not_found",
    });

    const open = new CampaignRewardClosureAdapter(
      store({ load: vi.fn(async () => source({ campaignStatus: "published", endsAt: "2026-09-18T12:00:00.000Z" })) }),
      () => NOW,
    );
    await expect(open.resolveClosureContext(CAMPAIGN, OWNER)).resolves.toMatchObject({
      kind: "not_closed",
      reasonCode: "participation_window_open",
    });

    const wrongType = new CampaignRewardClosureAdapter(
      store({ load: vi.fn(async () => source({ campaignType: "secret_drop" })) }),
      () => NOW,
    );
    await expect(wrongType.resolveClosureContext(CAMPAIGN, OWNER)).resolves.toMatchObject({
      kind: "not_closed",
    });

    const stranger = new CampaignRewardClosureAdapter(store(), () => NOW);
    await expect(stranger.resolveClosureContext(CAMPAIGN, OTHER)).resolves.toMatchObject({
      kind: "forbidden",
    });

    const broken = new CampaignRewardClosureAdapter(
      store({ load: vi.fn(async () => source({ bindingSourceId: "mismatch" })) }),
      () => NOW,
    );
    await expect(broken.resolveClosureContext(CAMPAIGN, OWNER)).resolves.toMatchObject({
      kind: "error",
      reasonCode: "malformed_source_binding",
    });
  });

  it("revalidates triggers against current source state", async () => {
    const adapter = new CampaignRewardClosureAdapter(store(), () => NOW);
    const resolved = await adapter.resolveClosureContext(CAMPAIGN, OWNER);
    if (resolved.kind !== "ready") throw new Error("expected ready context");
    await expect(adapter.revalidateTrigger(resolved.context.trigger)).resolves.toBe(true);

    const reopened = new CampaignRewardClosureAdapter(
      store({ load: vi.fn(async () => source({ campaignStatus: "published", endsAt: "2026-09-18T12:00:00.000Z" })) }),
      () => NOW,
    );
    await expect(reopened.revalidateTrigger(resolved.context.trigger)).resolves.toBe(false);

    await expect(adapter.revalidateTrigger({
      ...resolved.context.trigger,
      source: { type: "poll_vote", id: CAMPAIGN },
    })).resolves.toBe(false);
  });
});
