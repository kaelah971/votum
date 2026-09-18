import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { CampaignClaimStatus } from "@/components/campaign/CampaignClaimStatus";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function claimedResponse(overrides: Record<string, unknown> = {}) {
  return {
    claimed: true,
    status: "reserved",
    receiptId: "receipt-1",
    paidAt: null,
    transactionHash: null,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CampaignClaimStatus", () => {
  it("renders nothing when no claim exists", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ claimed: false }));
    const { container } = render(<CampaignClaimStatus campaignId={CAMPAIGN} />);
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("");
  });

  it("shows reserved copy without implying payment", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(claimedResponse({ status: "reserved" })));
    const { container } = render(<CampaignClaimStatus campaignId={CAMPAIGN} />);
    await flush();
    expect(screen.getByText("Claim reserved")).toBeTruthy();
    expect(container.textContent).not.toMatch(/paid/i);
  });

  it("maps payout_pending with and without a transaction hash", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(claimedResponse({ status: "payout_pending" })));
    const { unmount } = render(<CampaignClaimStatus campaignId={CAMPAIGN} />);
    await flush();
    expect(screen.getByText("Sending NIM")).toBeTruthy();
    unmount();

    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(
      jsonResponse(claimedResponse({ status: "payout_pending", transactionHash: "ab".repeat(32) })),
    );
    render(<CampaignClaimStatus campaignId={CAMPAIGN} />);
    await flush();
    expect(screen.getByText("Confirming payment")).toBeTruthy();
    expect(screen.getByText(/Verified transaction/)).toBeTruthy();
  });

  it("shows paid with verified styling and proof", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse(claimedResponse({
        status: "paid",
        paidAt: "2026-09-17T12:00:00.000Z",
        transactionHash: "ab".repeat(32),
      })),
    );
    const { container } = render(<CampaignClaimStatus campaignId={CAMPAIGN} />);
    await flush();
    const paid = screen.getByText("Paid");
    expect(paid).toBeTruthy();
    expect(paid.className).toMatch(/verified-green/);
    expect(container.textContent).toMatch(/Verified transaction/);
  });

  it("shows delayed copy with no retry or resend control", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(claimedResponse({ status: "retryable" })));
    const { container } = render(<CampaignClaimStatus campaignId={CAMPAIGN} />);
    await flush();
    expect(screen.getByText("Payout delayed")).toBeTruthy();
    expect(container.textContent).toMatch(/remains reserved/i);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).not.toMatch(/retry|resend|broadcast|send again/i);
  });

  it("exposes no payout controls in any claimed state", async () => {
    for (const status of ["reserved", "payout_pending", "paid", "retryable"]) {
      mocks.fetch.mockReset();
      mocks.fetch.mockResolvedValue(jsonResponse(claimedResponse({ status })));
      const { container, unmount } = render(<CampaignClaimStatus campaignId={CAMPAIGN} />);
      await flush();
      expect(mocks.fetch).toHaveBeenCalled();
      expect(container.textContent).not.toMatch(/retry|resend|broadcast|send again/i);
      expect(screen.queryByRole("button")).toBeNull();
      unmount();
    }
  });

  it("fetches immediately, polls while non-terminal, and stops at paid", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(claimedResponse({ status: "reserved" })));
    const { unmount } = render(<CampaignClaimStatus campaignId={CAMPAIGN} />);
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenLastCalledWith(
      `/api/campaigns/${CAMPAIGN}/claims/mine`,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    unmount();

    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(jsonResponse(claimedResponse({ status: "paid" })));
    render(<CampaignClaimStatus campaignId={`${CAMPAIGN}-paid`} />);
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes on window focus and cleans up on unmount", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(claimedResponse({ status: "reserved" })));
    const { unmount } = render(<CampaignClaimStatus campaignId={CAMPAIGN} />);
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("recovers claimed state from the endpoint with no E1 memory", async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse(claimedResponse({ status: "payout_pending", transactionHash: "cd".repeat(32) })),
    );
    render(<CampaignClaimStatus campaignId={CAMPAIGN} />);
    await flush();
    expect(screen.getByText("Confirming payment")).toBeTruthy();
  });

  it("keeps last known state across transient failures", async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse(claimedResponse({ status: "reserved" })))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse(claimedResponse({ status: "paid" })));
    render(<CampaignClaimStatus campaignId={CAMPAIGN} />);
    await flush();
    expect(screen.getByText("Claim reserved")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await flush();
    expect(screen.getByText("Claim reserved")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await flush();
    expect(screen.getByText("Paid")).toBeTruthy();
  });

  it("handles session and campaign failures deterministically", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ error: "session_missing" }, 401));
    const { unmount } = render(<CampaignClaimStatus campaignId={CAMPAIGN} />);
    await flush();
    expect(screen.getByText("Session unavailable")).toBeTruthy();
    const calls = mocks.fetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.fetch.mock.calls.length).toBe(calls);
    unmount();

    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(jsonResponse({ error: "not_found" }, 404));
    render(<CampaignClaimStatus campaignId={CAMPAIGN} />);
    await flush();
    expect(screen.getByText("Campaign unavailable")).toBeTruthy();
  });

  it("never regresses paid to an older pending response", async () => {
    let resolveStale!: (value: unknown) => void;
    let resolveFresh!: (value: unknown) => void;
    mocks.fetch
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFresh = resolve; }));
    render(<CampaignClaimStatus campaignId={CAMPAIGN} />);
    await flush();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveFresh(jsonResponse(claimedResponse({ status: "paid" })));
    });
    await flush();
    expect(screen.getByText("Paid")).toBeTruthy();

    await act(async () => {
      resolveStale(jsonResponse(claimedResponse({ status: "payout_pending" })));
    });
    await flush();
    expect(screen.queryByText("Confirming payment")).toBeNull();
    expect(screen.getByText("Paid")).toBeTruthy();
  });

  it("renders nothing and fetches nothing while disabled", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(claimedResponse({ status: "paid" })));
    const { container } = render(<CampaignClaimStatus campaignId={CAMPAIGN} enabled={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });
});
