import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPollRewardParticipationAdapter,
  type PollRewardParticipationRequest,
  type PollRewardParticipationStore,
} from "@/lib/rewards/poll-participation-adapter";

const POLL_ID = "poll-1";
const OTHER_POLL_ID = "poll-2";
const VOTE_ID = "vote-1";
const CAMPAIGN_ID = "campaign-1";
const PARTICIPANT = "01" + "a".repeat(38);
const OWNER = "02" + "b".repeat(38);
const OTHER_WALLET = "03" + "c".repeat(38);

function request(overrides: Partial<PollRewardParticipationRequest> = {}): PollRewardParticipationRequest {
  return {
    pollId: POLL_ID,
    participationId: VOTE_ID,
    verifiedSession: { address: PARTICIPANT },
    ...overrides,
  };
}

function makeStore(overrides: Partial<PollRewardParticipationStore> = {}) {
  const store: PollRewardParticipationStore = {
    loadVote: vi.fn(async () => ({
      id: VOTE_ID,
      pollId: POLL_ID,
      participantWallet: PARTICIPANT,
      committed: true,
    })),
    loadPoll: vi.fn(async () => ({
      id: POLL_ID,
      creatorWallet: OWNER,
      economicModel: "reward_first",
      rewardMode: "rewarded",
      isPublic: true,
      status: "live",
    })),
    loadSettlementBinding: vi.fn(async () => ({
      settlementId: CAMPAIGN_ID,
      pollId: POLL_ID,
    })),
    ...overrides,
  };

  return {
    store,
    adapter: createPollRewardParticipationAdapter(store),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PollRewardParticipationAdapter", () => {
  it("resolves an eligible rewarded Poll vote into the minimal context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T00:00:00.000Z"));
    const { adapter } = makeStore();

    const result = await adapter.resolveParticipation(request());

    expect(result).toMatchObject({
      kind: "eligible",
      context: {
        source: { type: "poll_vote", id: VOTE_ID },
        participantWallet: PARTICIPANT,
        ownerWallet: OWNER,
        eligibility: {
          evidenceId: VOTE_ID,
          evidenceKind: "verified_wallet_vote",
          verifiedAt: "2026-09-13T00:00:00.000Z",
        },
        settlement: {
          id: CAMPAIGN_ID,
          binding: { sourceType: "poll_vote", sourceId: POLL_ID },
        },
      },
    });
  });

  it("uses the durable vote ID as source evidence and the reward row ID as settlement ID", async () => {
    const { adapter } = makeStore();
    const result = await adapter.resolveParticipation(request());

    expect(result.kind).toBe("eligible");
    if (result.kind !== "eligible") return;

    expect(result.context.source.id).toBe(VOTE_ID);
    expect(result.context.eligibility.evidenceId).toBe(VOTE_ID);
    expect(result.context.settlement.id).toBe(CAMPAIGN_ID);
    expect(result.context.settlement.id).not.toBe(POLL_ID);
    expect(result.context.settlement.binding.sourceId).toBe(POLL_ID);
  });

  it("derives canonical participant and owner identity from server records", async () => {
    const { adapter } = makeStore({
      loadVote: vi.fn(async () => ({
        id: VOTE_ID,
        pollId: POLL_ID,
        participantWallet: PARTICIPANT.toUpperCase(),
        committed: true,
      })),
      loadPoll: vi.fn(async () => ({
        id: POLL_ID,
        creatorWallet: OWNER.toUpperCase(),
        economicModel: "reward_first",
        rewardMode: "rewarded",
        isPublic: true,
        status: "live",
      })),
    });

    const result = await adapter.resolveParticipation(request({
      verifiedSession: { address: PARTICIPANT.toUpperCase() },
    }));

    expect(result).toMatchObject({
      kind: "eligible",
      context: {
        participantWallet: PARTICIPANT.toLowerCase(),
        ownerWallet: OWNER.toLowerCase(),
      },
    });
  });

  it("rejects a session wallet mismatch", async () => {
    const { adapter } = makeStore();

    await expect(adapter.resolveParticipation(request({
      verifiedSession: { address: OTHER_WALLET },
    }))).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "session_wallet_mismatch",
      sourceId: VOTE_ID,
    });
  });

  it("fails closed for missing, uncommitted, or malformed source evidence", async () => {
    const missing = makeStore({ loadVote: vi.fn(async () => null) });
    await expect(missing.adapter.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "participation_not_found",
    });

    const uncommitted = makeStore({
      loadVote: vi.fn(async () => ({
        id: VOTE_ID,
        pollId: POLL_ID,
        participantWallet: PARTICIPANT,
        committed: false,
      })),
    });
    await expect(uncommitted.adapter.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "invalid_participation",
    });

    const malformed = makeStore({
      loadVote: vi.fn(async () => ({
        id: "",
        pollId: POLL_ID,
        participantWallet: "not-an-address",
        committed: true,
      })),
    });
    await expect(malformed.adapter.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "invalid_participation",
    });
  });

  it("rejects a vote belonging to another Poll before resolving the Poll", async () => {
    const { adapter, store } = makeStore({
      loadVote: vi.fn(async () => ({
        id: VOTE_ID,
        pollId: OTHER_POLL_ID,
        participantWallet: PARTICIPANT,
        committed: true,
      })),
    });

    await expect(adapter.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "participation_poll_mismatch",
      sourceId: VOTE_ID,
    });
    expect(store.loadPoll).not.toHaveBeenCalled();
    expect(store.loadSettlementBinding).not.toHaveBeenCalled();
  });

  it("rejects a missing Poll or invalid Poll owner", async () => {
    const missing = makeStore({ loadPoll: vi.fn(async () => null) });
    await expect(missing.adapter.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "poll_not_found",
    });

    const malformed = makeStore({
      loadPoll: vi.fn(async () => ({
        id: POLL_ID,
        creatorWallet: "not-an-address",
        economicModel: "reward_first",
        rewardMode: "rewarded",
        isPublic: true,
        status: "live",
      })),
    });
    await expect(malformed.adapter.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "invalid_poll",
    });
  });

  it.each([
    { isPublic: false, status: "live" },
    { isPublic: true, status: "draft" },
    { isPublic: true, status: "cancelled" },
  ])("fails closed for a private or non-public Poll: $isPublic/$status", async (poll) => {
    const { adapter } = makeStore({
      loadPoll: vi.fn(async () => ({
        id: POLL_ID,
        creatorWallet: OWNER,
        economicModel: "reward_first",
        rewardMode: "rewarded",
        ...poll,
      })),
    });

    await expect(adapter.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "poll_not_public",
    });
  });

  it("excludes legacy support Polls even when a reward row is present", async () => {
    const { adapter, store } = makeStore({
      loadPoll: vi.fn(async () => ({
        id: POLL_ID,
        creatorWallet: OWNER,
        economicModel: "legacy_support",
        rewardMode: null,
        isPublic: true,
        status: "live",
      })),
    });

    await expect(adapter.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "poll_not_rewarded",
    });
    expect(store.loadSettlementBinding).not.toHaveBeenCalled();
  });

  it("excludes free reward-first Polls", async () => {
    const { adapter, store } = makeStore({
      loadPoll: vi.fn(async () => ({
        id: POLL_ID,
        creatorWallet: OWNER,
        economicModel: "reward_first",
        rewardMode: "free",
        isPublic: true,
        status: "live",
      })),
    });

    await expect(adapter.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "poll_not_rewarded",
    });
    expect(store.loadSettlementBinding).not.toHaveBeenCalled();
  });

  it("allows a creator vote as Poll participation but excludes self-reward", async () => {
    const { adapter, store } = makeStore({
      loadVote: vi.fn(async () => ({
        id: VOTE_ID,
        pollId: POLL_ID,
        participantWallet: OWNER,
        committed: true,
      })),
    });

    await expect(adapter.resolveParticipation(request({
      verifiedSession: { address: OWNER },
    }))).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "creator_not_reward_eligible",
      sourceId: VOTE_ID,
    });
    expect(store.loadSettlementBinding).not.toHaveBeenCalled();
  });

  it("fails closed for missing or mismatched settlement binding", async () => {
    const missing = makeStore({ loadSettlementBinding: vi.fn(async () => null) });
    await expect(missing.adapter.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "settlement_binding_missing",
    });

    const mismatch = makeStore({
      loadSettlementBinding: vi.fn(async () => ({
        settlementId: CAMPAIGN_ID,
        pollId: OTHER_POLL_ID,
      })),
    });
    await expect(mismatch.adapter.resolveParticipation(request())).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "settlement_binding_mismatch",
    });
  });

  it("rejects browser option and authority fields at the adapter boundary", async () => {
    const { adapter } = makeStore();
    const browserRequest = {
      ...request(),
      optionId: "option-a",
      selectedOptionId: "option-a",
      eligible: true,
      participantWallet: OTHER_WALLET,
      ownerWallet: OTHER_WALLET,
      settlementId: "browser-settlement",
      rewardAmountLuna: 1,
      capacity: 1,
      vaultAddressHex: "browser-vault",
    } as unknown as PollRewardParticipationRequest;

    await expect(adapter.resolveParticipation(browserRequest)).resolves.toMatchObject({
      kind: "ineligible",
      reasonCode: "invalid_request",
    });
  });

  it("does not vary the shared context with option choice", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T00:00:00.000Z"));
    const { adapter } = makeStore();

    const optionA = await adapter.resolveParticipation(request());
    const optionB = await adapter.resolveParticipation(request());

    expect(optionA).toEqual(optionB);
    if (optionA.kind === "eligible") {
      const serialized = JSON.stringify(optionA.context);
      expect(serialized).not.toMatch(/option|choice|selected/i);
    }
  });

  it("does not ask the source store for financial authority", async () => {
    const { adapter, store } = makeStore();

    await adapter.resolveParticipation(request());

    expect(store.loadVote).toHaveBeenCalledWith(VOTE_ID);
    expect(store.loadPoll).toHaveBeenCalledWith(POLL_ID);
    expect(store.loadSettlementBinding).toHaveBeenCalledWith(POLL_ID);
    expect(Object.keys(store)).toEqual([
      "loadVote",
      "loadPoll",
      "loadSettlementBinding",
    ]);
  });
});
