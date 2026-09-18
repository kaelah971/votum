import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/polls/[pollId]/reward/funding/intents/[intentId]/confirm/route";

const POLL = "11111111-1111-4111-8111-111111111111";
const INTENT = "33333333-3333-4333-8333-333333333333";
const SETTLEMENT = "22222222-2222-4222-8222-222222222222";
const OWNER = "01" + "a".repeat(38);
const HASH = "ab".repeat(32);

const mocks = vi.hoisted(() => ({
  session: null as { address: string } | null,
  confirm: vi.fn(),
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => Promise.resolve(mocks.session),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { id: POLL, is_public: true }, error: null }),
        }),
      }),
    }),
  }),
  getAdminConfigStatus: () => ({ configured: true }),
}));

vi.mock("@/lib/rewards/settlement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rewards/settlement")>();
  return {
    ...actual,
    resolvePollRewardSettlement: async () => ({ kind: "ok", settlementId: SETTLEMENT }),
    createRewardSettlementService: () => ({ confirmFunding: mocks.confirm }),
  };
});

function post(): Request {
  return new Request(`http://localhost/api/polls/${POLL}/reward/funding/intents/${INTENT}/confirm`, {
    method: "POST",
  });
}

const params = Promise.resolve({ pollId: POLL, intentId: INTENT });

beforeEach(() => {
  mocks.session = { address: OWNER };
  mocks.confirm.mockReset();
});

describe("POST poll funding confirm — JSON-safe boundary", () => {
  it("returns 200 with decimal-string amounts for bigint engine results", async () => {
    mocks.confirm.mockResolvedValue({
      kind: "confirmed",
      decision: {
        status: "confirmed",
        reasonCode: "confirmed_success",
        confirmed: true,
        expectedTransactionHash: HASH,
        observedTransactionHash: HASH,
        expectedAmountLuna: BigInt("9223372036854775807"),
        observedAmountLuna: BigInt("9223372036854775807"),
        excessAmountLuna: BigInt(0),
        amountComparison: "exact",
      },
      atomic: { kind: "confirmed", data: { result_kind: "confirmed" } },
    });
    const response = await POST(post(), { params });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.confirmation.kind).toBe("confirmed");
    expect(body.confirmation.decision.expectedAmountLuna).toBe("9223372036854775807");
    expect(body.confirmation.decision.observedAmountLuna).toBe("9223372036854775807");
    expect(body.confirmation.decision.excessAmountLuna).toBe("0");
  });

  it("leaves failure behavior unchanged", async () => {
    mocks.confirm.mockResolvedValue({ kind: "not_confirmable", reasonCode: "intent_unbound" });
    const response = await POST(post(), { params });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      confirmation: { kind: "not_confirmable", reasonCode: "intent_unbound" },
    });
  });
});
