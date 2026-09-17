import { describe, expect, it, vi } from "vitest";
import {
  createCampaignRewardParticipationAdapter,
  type CampaignRewardParticipationStore,
} from "@/lib/rewards/campaign-participation-adapter";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const CHALLENGE = "33333333-3333-4333-8333-333333333333";
const PARTICIPANT = "01" + "a".repeat(38);
const OWNER = "02" + "b".repeat(38);
const SETTLEMENT = "44444444-4444-4444-8444-444444444444";

function store(overrides: Partial<CampaignRewardParticipationStore> = {}): CampaignRewardParticipationStore {
  return {
    loadCampaign: vi.fn(async () => ({
      id: CAMPAIGN,
      campaignType: "public_giveaway",
      status: "published",
      ownerWallet: OWNER,
      startsAt: null,
      endsAt: null,
    })),
    loadSettlementBinding: vi.fn(async () => ({
      settlementId: SETTLEMENT,
      campaignId: CAMPAIGN,
    })),
    loadChallenge: vi.fn(async () => ({
      id: CHALLENGE,
      campaignId: CAMPAIGN,
      participantWallet: PARTICIPANT,
      consumed: false,
    })),
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    campaignId: CAMPAIGN,
    challengeId: CHALLENGE,
    verifiedSession: { address: PARTICIPANT },
    ...overrides,
  };
}

describe("createCampaignRewardParticipationAdapter", () => {
  it("rejects malformed requests without touching stores", async () => {
    const adapter = createCampaignRewardParticipationAdapter(store());
    await expect(adapter.resolveParticipation(request({ campaignId: "" }))).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "invalid_request",
    });
    await expect(adapter.resolveParticipation(request({ verifiedSession: { address: "" } }))).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "invalid_request",
    });
  });

  it("rejects unknown campaigns and binding failures", async () => {
    const missing = createCampaignRewardParticipationAdapter(
      store({ loadCampaign: vi.fn(async () => null) }),
    );
    await expect(missing.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "campaign_not_found",
      sourceId: CAMPAIGN,
    });

    const unbound = createCampaignRewardParticipationAdapter(
      store({ loadSettlementBinding: vi.fn(async () => null) }),
    );
    await expect(unbound.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "settlement_binding_missing",
      sourceId: CHALLENGE,
    });
  });

  it("rejects unsupported types and unpublished campaigns", async () => {
    const wrongType = createCampaignRewardParticipationAdapter(
      store({ loadCampaign: vi.fn(async () => ({
        id: CAMPAIGN, campaignType: "secret_drop", status: "published",
        ownerWallet: OWNER, startsAt: null, endsAt: null,
      })) }),
    );
    await expect(wrongType.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "unsupported_type",
    });

    const draft = createCampaignRewardParticipationAdapter(
      store({ loadCampaign: vi.fn(async () => ({
        id: CAMPAIGN, campaignType: "public_giveaway", status: "draft",
        ownerWallet: OWNER, startsAt: null, endsAt: null,
      })) }),
    );
    await expect(draft.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "campaign_not_published",
    });
  });

  it("rejects session, challenge, and creator mismatches", async () => {
    const adapter = createCampaignRewardParticipationAdapter(store());
    await expect(
      adapter.resolveParticipation(request({ verifiedSession: { address: "03" + "c".repeat(38) } })),
    ).resolves.toMatchObject({ kind: "ineligible", reasonCode: "session_wallet_mismatch" });

    const crossCampaign = createCampaignRewardParticipationAdapter(
      store({ loadChallenge: vi.fn(async () => ({
        id: CHALLENGE, campaignId: "55555555-5555-4555-8555-555555555555",
        participantWallet: PARTICIPANT, consumed: false,
      })) }),
    );
    await expect(crossCampaign.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "challenge_campaign_mismatch",
    });

    const crossWallet = createCampaignRewardParticipationAdapter(
      store({ loadChallenge: vi.fn(async () => ({
        id: CHALLENGE, campaignId: CAMPAIGN,
        participantWallet: "not-a-wallet", consumed: false,
      })) }),
    );
    await expect(crossWallet.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "challenge_wallet_mismatch",
    });

    const creator = createCampaignRewardParticipationAdapter(
      store({ loadChallenge: vi.fn(async () => ({
        id: CHALLENGE, campaignId: CAMPAIGN, participantWallet: OWNER, consumed: false,
      })) }),
    );
    await expect(
      creator.resolveParticipation(request({ verifiedSession: { address: OWNER } })),
    ).resolves.toMatchObject({ kind: "ineligible", reasonCode: "creator_not_reward_eligible" });
  });

  it("passes consumed challenges through for the authoritative RPC replay decision", async () => {
    // M3 replays an already-consumed challenge when its reservation exists
    // and rejects it otherwise; the adapter must not pre-empt that split.
    const adapter = createCampaignRewardParticipationAdapter(
      store({ loadChallenge: vi.fn(async () => ({
        id: CHALLENGE, campaignId: CAMPAIGN, participantWallet: PARTICIPANT, consumed: true,
      })) }),
    );
    const result = await adapter.resolveParticipation(request());
    expect(result.kind).toBe("eligible");
    if (result.kind !== "eligible") throw new Error("expected eligible context");
    expect(result.context.source).toEqual({ type: "campaign_claim", id: CHALLENGE });
  });

  it("resolves an eligible campaign-claim context carrying no economics", async () => {
    const adapter = createCampaignRewardParticipationAdapter(store());
    const result = await adapter.resolveParticipation(request());
    expect(result.kind).toBe("eligible");
    if (result.kind !== "eligible") throw new Error("expected eligible context");
    expect(result.context).toEqual({
      source: { type: "campaign_claim", id: CHALLENGE },
      participantWallet: PARTICIPANT,
      ownerWallet: OWNER,
      eligibility: {
        evidenceId: CHALLENGE,
        evidenceKind: "verified_wallet_claim",
        verifiedAt: expect.any(String),
      },
      settlement: {
        id: SETTLEMENT,
        binding: { sourceType: "campaign_claim", sourceId: CAMPAIGN },
      },
    });
    const serialized = JSON.stringify(result.context);
    for (const forbidden of ["amount", "capacity", "vault", "reward_per", "status", "funded"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("treats store failures as source_resolution_failed", async () => {
    const failing = createCampaignRewardParticipationAdapter(
      store({ loadCampaign: vi.fn(async () => { throw new Error("db down"); }) }),
    );
    await expect(failing.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "source_resolution_failed",
    });
  });
});
