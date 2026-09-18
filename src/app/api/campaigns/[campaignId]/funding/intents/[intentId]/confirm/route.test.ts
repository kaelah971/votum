import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "01" + "a".repeat(38);

const mocks = vi.hoisted(() => ({
  session: { address: "01" + "a".repeat(38) } as { address: string } | null,
  sameOrigin: true,
  admin: { marker: "admin" },
  confirm: vi.fn(),
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/api/origin", () => ({
  isSameOriginRequest: () => mocks.sameOrigin,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mocks.admin,
  getAdminConfigStatus: () => ({ configured: true }),
}));

vi.mock("@/lib/campaigns/funding", () => ({
  confirmCampaignFunding: (...args: unknown[]) => mocks.confirm(...args),
}));

import { POST } from "@/app/api/campaigns/[campaignId]/funding/intents/[intentId]/confirm/route";

function context(campaignId = "campaign-1", intentId = "intent-1") {
  return { params: Promise.resolve({ campaignId, intentId }) };
}

function request(): Request {
  return new Request("http://localhost/api/x", { method: "POST" });
}

beforeEach(() => {
  mocks.session = { address: OWNER };
  mocks.sameOrigin = true;
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue({ kind: "confirmed", decision: {}, atomic: {} });
});

describe("POST /api/campaigns/[campaignId]/funding/intents/[intentId]/confirm", () => {
  it("rejects cross-origin requests before any funding work", async () => {
    mocks.sameOrigin = false;
    const response = await POST(request(), context());

    expect(response.status).toBe(403);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("requires a verified wallet session", async () => {
    mocks.session = null;
    const response = await POST(request(), context());

    expect(response.status).toBe(401);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("delegates confirmation with server-resolved identity only", async () => {
    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.confirm).toHaveBeenCalledWith(mocks.admin, "campaign-1", "intent-1", OWNER);
    const body = await response.json();
    expect(body.confirmation).toBeDefined();
  });

  it("maps forbidden and unknown intents to typed statuses", async () => {
    mocks.confirm.mockResolvedValue({ kind: "forbidden" });
    await expect(POST(request(), context()).then((r) => r.status)).resolves.toBe(403);

    mocks.confirm.mockResolvedValue({ kind: "not_found", reasonCode: "intent_not_found" });
    const missing = await POST(request(), context());
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("not_found");
  });

  it("contains source-neutral engine vocabulary in Campaign wording", async () => {
    for (const [reasonCode, error] of [
      ["settlement_not_found", "campaign_not_found"],
      ["source_not_supported", "campaign_not_found"],
      ["funding_not_allowed", "forbidden"],
      ["funding_conflict", "campaign_state_conflict"],
    ] as const) {
      mocks.confirm.mockResolvedValue({ kind: "error", reasonCode });
      const response = await POST(request(), context());
      expect((await response.json()).error, reasonCode).toBe(error);
    }
  });
});

describe("POST campaign funding confirm — JSON-safe boundary", () => {
  it("returns 200 with decimal-string amounts for bigint engine results", async () => {
    const hash = "ab".repeat(32);
    mocks.confirm.mockResolvedValue({
      kind: "confirmed",
      decision: {
        status: "confirmed",
        reasonCode: "confirmed_success",
        confirmed: true,
        expectedTransactionHash: hash,
        observedTransactionHash: hash,
        expectedAmountLuna: BigInt("9223372036854775807"),
        observedAmountLuna: BigInt("9223372036854775807"),
        excessAmountLuna: BigInt(0),
        amountComparison: "exact",
      },
      atomic: { kind: "confirmed", data: { result_kind: "confirmed" } },
    });
    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.confirmation.kind).toBe("confirmed");
    expect(body.confirmation.decision.expectedAmountLuna).toBe("9223372036854775807");
    expect(body.confirmation.decision.observedAmountLuna).toBe("9223372036854775807");
    expect(body.confirmation.decision.excessAmountLuna).toBe("0");
    expect(body.stage).toBe("atomic_confirm");
  });

  it("serializes reconciled decisions without precision loss", async () => {
    mocks.confirm.mockResolvedValue({
      kind: "reconciled",
      decision: {
        status: "confirmed",
        reasonCode: "confirmed_success",
        confirmed: true,
        expectedAmountLuna: BigInt("9223372036854775807"),
        observedAmountLuna: null,
        excessAmountLuna: BigInt(0),
        amountComparison: "exact",
      },
    });
    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.confirmation.decision.expectedAmountLuna).toBe("9223372036854775807");
    expect(body.confirmation.decision.observedAmountLuna).toBeNull();
  });
});
