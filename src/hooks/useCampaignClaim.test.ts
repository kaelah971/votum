import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCampaignClaim } from "@/hooks/useCampaignClaim";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const CLAIMANT = "02" + "b".repeat(38);
const CHALLENGE = {
  challengeId: "33333333-3333-4333-8333-333333333333",
  message: "Votum campaign claim\n\nCampaign: x",
  expiresAt: "2026-09-17T12:05:00.000Z",
};
const SIGNATURE = { publicKey: "9".repeat(64), signature: "ab".repeat(32) };
const RECEIPT = {
  receiptId: "55555555-5555-4555-8555-555555555555",
  settlementId: "44444444-4444-4444-8444-444444444444",
  status: "reserved",
  replayed: false,
};

const mocks = vi.hoisted(() => ({
  session: {
    isSessionVerified: true,
    isWalletMatched: true,
    verifiedWalletAddress: "02" + "b".repeat(38),
  } as {
    isSessionVerified: boolean;
    isWalletMatched: boolean;
    verifiedWalletAddress: string | null;
  },
  nimiq: {
    provider: { marker: "provider" },
    activeAccount: "02" + "b".repeat(38),
  },
  sign: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/providers/VotumSessionProvider", () => ({
  useVotumSession: () => mocks.session,
}));

vi.mock("@/providers/NimiqProvider", () => ({
  useNimiqContext: () => mocks.nimiq,
}));

vi.mock("@/lib/nimiq/client", () => ({
  signMessage: (...args: unknown[]) => mocks.sign(...args),
}));

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  mocks.session = {
    isSessionVerified: true,
    isWalletMatched: true,
    verifiedWalletAddress: CLAIMANT,
  };
  mocks.nimiq = { provider: { marker: "provider" }, activeAccount: CLAIMANT };
  mocks.sign.mockReset();
  mocks.fetch.mockReset();
  mocks.sign.mockResolvedValue({ ...SIGNATURE });
  mocks.fetch
    .mockResolvedValueOnce(jsonResponse({ ...CHALLENGE }))
    .mockResolvedValueOnce(jsonResponse({ ...RECEIPT }));
  vi.stubGlobal("fetch", mocks.fetch);
});

describe("useCampaignClaim", () => {
  it("runs challenge, signature, and claim with exact payloads", async () => {
    const { result } = renderHook(() => useCampaignClaim(CAMPAIGN));
    expect(result.current.phase).toBe("idle");

    await act(async () => {
      await result.current.start();
    });

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      1,
      `/api/campaigns/${CAMPAIGN}/claims/challenge`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(mocks.sign).toHaveBeenCalledWith(mocks.nimiq.provider, CHALLENGE.message);
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      2,
      `/api/campaigns/${CAMPAIGN}/claims`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          challengeId: CHALLENGE.challengeId,
          address: CLAIMANT,
          publicKey: SIGNATURE.publicKey,
          signature: SIGNATURE.signature,
        }),
      }),
    );
    expect(result.current).toMatchObject({ phase: "done", errorCode: null, receipt: RECEIPT });
  });

  it("preserves replayed receipts as success", async () => {
    mocks.fetch.mockReset();
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ ...CHALLENGE }))
      .mockResolvedValueOnce(jsonResponse({ ...RECEIPT, replayed: true }));
    vi.stubGlobal("fetch", mocks.fetch);

    const { result } = renderHook(() => useCampaignClaim(CAMPAIGN));
    await act(async () => {
      await result.current.start();
    });

    expect(result.current.phase).toBe("done");
    expect(result.current.receipt).toMatchObject({ replayed: true, receiptId: RECEIPT.receiptId });
  });

  it("returns signature rejection to a restartable state without retrying", async () => {
    mocks.sign.mockResolvedValue({ denied: true });
    const { result } = renderHook(() => useCampaignClaim(CAMPAIGN));
    await act(async () => {
      await result.current.start();
    });

    expect(result.current).toMatchObject({ phase: "error", errorCode: "signature_rejected", receipt: null });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.sign).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.reset();
    });
    expect(result.current).toMatchObject({ phase: "idle", errorCode: null });
  });

  it("refuses to start without a verified matched session", async () => {
    mocks.session = { isSessionVerified: false, isWalletMatched: false, verifiedWalletAddress: null };
    const { result } = renderHook(() => useCampaignClaim(CAMPAIGN));
    await act(async () => {
      await result.current.start();
    });

    expect(result.current).toMatchObject({ phase: "error", errorCode: "session_missing" });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("retries once with a fresh challenge on expiry, then surfaces the code", async () => {
    const fresh = { ...CHALLENGE, challengeId: "44444444-4444-4444-8444-444444444444" };
    mocks.fetch.mockReset();
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ ...CHALLENGE }))
      .mockResolvedValueOnce(jsonResponse({ error: "challenge_expired" }, 422))
      .mockResolvedValueOnce(jsonResponse({ ...fresh }))
      .mockResolvedValueOnce(jsonResponse({ ...RECEIPT }));
    vi.stubGlobal("fetch", mocks.fetch);

    const { result } = renderHook(() => useCampaignClaim(CAMPAIGN));
    await act(async () => {
      await result.current.start();
    });

    expect(result.current.phase).toBe("done");
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
    expect(mocks.sign).toHaveBeenCalledTimes(2);
    expect(mocks.sign).toHaveBeenLastCalledWith(mocks.nimiq.provider, fresh.message);
  });

  it("bounds fresh-challenge retry and never loops", async () => {
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(jsonResponse({ error: "challenge_consumed" }, 422));
    // First call must still fetch a challenge before claim attempts fail.
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ ...CHALLENGE }));
    vi.stubGlobal("fetch", mocks.fetch);

    const { result } = renderHook(() => useCampaignClaim(CAMPAIGN));
    await act(async () => {
      await result.current.start();
    });

    expect(result.current).toMatchObject({ phase: "error", errorCode: "challenge_consumed" });
    expect(mocks.fetch.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("maps lifecycle and auth failures one to one", async () => {
    for (const [serverBody, status, code] of [
      [{ error: "claim_not_available", reasonCode: "not_published" }, 422, "not_published"],
      [{ error: "claim_not_available", reasonCode: "not_started" }, 422, "not_started"],
      [{ error: "claim_not_available", reasonCode: "ended" }, 422, "ended"],
      [{ error: "claim_not_available", reasonCode: "funding_pending" }, 422, "funding_pending"],
      [{ error: "claim_not_available", reasonCode: "creator_ineligible" }, 422, "creator_ineligible"],
      [{ error: "claim_not_available", reasonCode: "sold_out" }, 409, "sold_out"],
      [{ error: "claim_not_available", reasonCode: "closed" }, 422, "closed"],
      [{ error: "invalid_signature" }, 422, "invalid_signature"],
      [{ error: "campaign_not_found" }, 404, "campaign_not_found"],
      [{ error: "claim_failed" }, 500, "claim_failed"],
    ] as const) {
      mocks.fetch.mockReset();
      mocks.fetch
        .mockResolvedValueOnce(jsonResponse({ ...CHALLENGE }))
        .mockResolvedValueOnce(jsonResponse(serverBody, status));
      vi.stubGlobal("fetch", mocks.fetch);

      const { result } = renderHook(() => useCampaignClaim(CAMPAIGN));
      await act(async () => {
        await result.current.start();
      });
      expect(result.current, JSON.stringify(serverBody)).toMatchObject({ phase: "error", errorCode: code });
    }
  });

  it("falls back generically on unknown failures", async () => {
    mocks.fetch.mockReset();
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ ...CHALLENGE }))
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", mocks.fetch);

    const { result } = renderHook(() => useCampaignClaim(CAMPAIGN));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current).toMatchObject({ phase: "error", errorCode: "claim_failed", receipt: null });
  });
});
