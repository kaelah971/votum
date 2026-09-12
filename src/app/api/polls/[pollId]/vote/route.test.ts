import { beforeEach, describe, expect, it, vi } from "vitest";

const VOTER = "01" + "a".repeat(38);

const mocks = vi.hoisted(() => ({
  session: { address: "01" + "a".repeat(38) } as { address: string } | null,
  campaign: true,
  rpc: vi.fn(),
  payout: vi.fn(),
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/supabase/admin", () => ({
  getAdminConfigStatus: () => ({ configured: true }),
  createAdminClient: () => ({
    rpc: mocks.rpc,
    from: () => {
      const value = {
        select: () => value,
        eq: () => value,
        maybeSingle: async () => ({ data: mocks.campaign ? { id: "campaign-1" } : null, error: null }),
      };
      return value;
    },
  }),
}));

vi.mock("@/lib/rewards/payout", () => ({
  executeReservedRewardPayout: mocks.payout,
}));

import { POST } from "@/app/api/polls/[pollId]/vote/route";

beforeEach(() => {
  mocks.session = { address: VOTER };
  mocks.campaign = true;
  mocks.rpc.mockReset();
  mocks.payout.mockReset();
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "cast_poll_vote_atomic") {
      return { data: { result_kind: "created", vote_id: "vote-1", created_at: "2026-09-12T00:00:00.000Z" }, error: null };
    }
    return { data: null, error: { code: "reservation_failed", message: "fixture failure" } };
  });
});

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/polls/poll-1/vote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/polls/[pollId]/vote compatibility boundary", () => {
  it("keeps a valid vote when best-effort reward reservation fails", async () => {
    const response = await POST(request({ optionId: "option-a" }), {
      params: Promise.resolve({ pollId: "poll-1" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      resultKind: "created",
      vote: { id: "vote-1", optionId: "option-a" },
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "cast_poll_vote_atomic", expect.objectContaining({
      _voter_wallet: VOTER,
    }));
    expect(mocks.payout).not.toHaveBeenCalled();
  });

  it("keeps free polls free when no reward campaign exists", async () => {
    mocks.campaign = false;
    const response = await POST(request({ optionId: "option-a" }), {
      params: Promise.resolve({ pollId: "poll-1" }),
    });

    expect(response.status).toBe(201);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.payout).not.toHaveBeenCalled();
  });
});
