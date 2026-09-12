import { beforeEach, describe, expect, it, vi } from "vitest";

const CREATOR = "01" + "a".repeat(38);
const CAMPAIGN_ID = "campaign-free-poll";

const mocks = vi.hoisted(() => ({
  session: { address: "01" + "a".repeat(38) } as { address: string } | null,
  admin: null as Record<string, unknown> | null,
  ensureCampaignVault: vi.fn(),
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/supabase/admin", () => ({
  getAdminConfigStatus: () => ({ configured: true }),
  createAdminClient: () => mocks.admin,
}));

vi.mock("@/lib/rewards/vault-service", () => ({
  ensureCampaignVault: mocks.ensureCampaignVault,
}));

import { GET, POST } from "@/app/api/polls/[pollId]/reward/config/route";

type Chain = {
  select: () => Chain;
  eq: () => Chain;
  maybeSingle: () => Promise<{ data: unknown; error: null }>;
  insert: () => Chain;
  update: () => Chain;
  single: () => Promise<{ data: unknown; error: null }>;
};

function chain(data: unknown): Chain {
  const value = {} as Chain;
  value.select = () => value;
  value.eq = () => value;
  value.maybeSingle = async () => ({ data, error: null });
  value.insert = () => value;
  value.update = () => value;
  value.single = async () => ({
    data: {
      id: CAMPAIGN_ID,
      status: "configured",
      ...(data as object),
    },
    error: null,
  });
  return value;
}

beforeEach(() => {
  let campaignReads = 0;
  mocks.session = { address: CREATOR };
  mocks.ensureCampaignVault.mockReset();
  mocks.ensureCampaignVault.mockResolvedValue({ vaultAddressHex: "02" + "b".repeat(38) });
  mocks.admin = {
    from: vi.fn((table: string) => {
      if (table === "polls") {
        return chain({
          id: "poll-free",
          creator_wallet: CREATOR,
          is_public: true,
          question: "A free poll",
          economic_model: "reward_first",
          reward_mode: "free",
        });
      }
      if (table === "reward_campaigns") {
        campaignReads++;
        if (campaignReads === 1) return chain(null);
        return chain({
          id: CAMPAIGN_ID,
          poll_id: "poll-free",
          creator_wallet: CREATOR,
          funding_mode: "creator",
          funding_wallet: CREATOR,
          reward_per_participant_luna: 100000,
          max_rewarded_participants: 1,
          reward_principal_luna: 100000,
          fee_reserve_luna: 100000,
          total_budget_luna: 200000,
          status: "configured",
          vault_wallet: null,
        });
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
});

describe("POST /api/polls/[pollId]/reward/config compatibility boundary", () => {
  it("rejects reward configuration for a free reward-first poll", async () => {
    const response = await POST(
      new Request("http://localhost/api/polls/poll-free/reward/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rewardPerParticipant: "1", maxRewardedParticipants: 1 }),
      }),
      { params: Promise.resolve({ pollId: "poll-free" }) },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "poll_not_rewardable" });
    expect(mocks.ensureCampaignVault).not.toHaveBeenCalled();
  });

  it("does not expose reward configuration for a free reward-first poll", async () => {
    const response = await GET(
      new Request("http://localhost/api/polls/poll-free/reward/config"),
      { params: Promise.resolve({ pollId: "poll-free" }) },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "poll_not_rewardable" });
  });
});
