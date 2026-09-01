import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RewardFundingPanel } from "@/components/creator/RewardFundingPanel";
import { sendBasicTransactionWithData } from "@/lib/nimiq/client";

const mocks = vi.hoisted(() => ({
  nimiq: {
    provider: {},
    isInsideNimiqPay: true,
    walletStatus: "connected",
  },
  session: {
    isSessionVerified: true,
    isWalletMatched: true,
  },
}));

vi.mock("@/providers/NimiqProvider", () => ({
  useNimiqContext: () => mocks.nimiq,
}));

vi.mock("@/providers/VotumSessionProvider", () => ({
  useVotumSession: () => mocks.session,
}));

vi.mock("@/lib/nimiq/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nimiq/client")>();
  return {
    ...actual,
    sendBasicTransactionWithData: vi.fn(),
  };
});

const sendTransactionMock = vi.mocked(sendBasicTransactionWithData);

const configuredConfig = {
  pollQuestion: "VB.2 Reward Funding QA",
  economicModel: "reward_first",
  rewardMode: "rewarded",
  state: "configured",
  rewardPerParticipant: { luna: "1000", nim: 0.01 },
  maxRewardedParticipants: 1,
  rewardPrincipal: { luna: "1000", nim: 0.01 },
  feeReserve: { luna: "8000", nim: 0.08 },
  totalRequiredFunding: { luna: "9000", nim: 0.09 },
  vaultAddressNq: "NQ00 0000 0000 0000 0000 0000 0000 0000 0000",
  funding: null,
};

const fundingIntent = {
  fundingIntentId: "intent-1",
  campaignId: "campaign-1",
  reference: "votum:fund:test",
  memo: "votum:fund:test",
  vaultAddressNq: configuredConfig.vaultAddressNq,
  rewardPrincipalLuna: "1000",
  feeReserveLuna: "8000",
  requiredFundingLuna: "9000",
  requiredFundingNim: "0.09 NIM",
  submittedTransactionHash: null,
  confirmationDeadline: null,
  createdAt: "2026-08-31T00:00:00.000Z",
};

function mockConfig(config: Record<string, unknown>, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => (status === 200 ? { config } : {}),
    }),
  );
}

function mockFundingFlow() {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/bind")) {
      return Promise.resolve({ ok: true, status: 201, json: async () => ({}) });
    }
    if (path.endsWith("/reward/funding/intents")) {
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ fundingIntent }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: configuredConfig }) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sendTransactionMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RewardFundingPanel canonical creator surface", () => {
  it("renders server-authoritative campaign identity and terms", async () => {
    mockConfig(configuredConfig);
    render(<RewardFundingPanel pollId="poll-qa" />);

    await waitFor(() => expect(screen.getByText("VB.2 Reward Funding QA")).toBeInTheDocument());
    expect(screen.getByText("Rewarded participation")).toBeInTheDocument();
    expect(screen.getByText("Reward per participant")).toBeInTheDocument();
    expect(screen.getByText("Maximum rewarded participants")).toBeInTheDocument();
    expect(screen.getAllByText("0.01 NIM")).toHaveLength(2);
    expect(screen.getByText("0.08 NIM")).toBeInTheDocument();
    expect(screen.getByText("0.09 NIM")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fund reward campaign" })).toBeInTheDocument();
    expect(screen.getByText(/NQ00 0000/)).toBeInTheDocument();
  });

  it("shows submitted funding as pending without a duplicate funding CTA", async () => {
    mockConfig({
      ...configuredConfig,
      state: "funding_pending",
      funding: {
        fundingIntentId: "intent-1",
        campaignId: "campaign-1",
        reference: "votum:fund:test",
        status: "submitted",
        amountLuna: "9000",
        rewardPrincipalLuna: "1000",
        feeReserveLuna: "8000",
        submittedTransactionHash: null,
        confirmationDeadline: null,
        createdAt: "2026-08-31T00:00:00.000Z",
      },
    });
    render(<RewardFundingPanel pollId="poll-qa" />);

    await waitFor(() => expect(screen.getByText(/Funding submitted/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Fund reward campaign|Retry funding/ })).not.toBeInTheDocument();
  });

  it("shows funded state without a Fund CTA", async () => {
    mockConfig({ ...configuredConfig, state: "funded" });
    render(<RewardFundingPanel pollId="poll-qa" />);

    await waitFor(() => expect(screen.getByText("Rewards funded")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Fund reward campaign|Retry funding/ })).not.toBeInTheDocument();
  });

  it("renders no creator funding controls for a non-owner response", async () => {
    mockConfig({}, 403);
    render(<RewardFundingPanel pollId="poll-qa" />);

    await waitFor(() => expect(screen.queryByText("Fund reward campaign")).not.toBeInTheDocument());
  });

  it("handles the SDK cancellation shape without leaking or binding a hash", async () => {
    const fetchMock = mockFundingFlow();
    sendTransactionMock.mockRejectedValueOnce({
      code: 4001,
      message: "User rejected the request.",
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      render(<RewardFundingPanel pollId="poll-qa" />);
      const button = await screen.findByRole("button", { name: "Fund reward campaign" });
      fireEvent.click(button);

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("Funding cancelled. No transaction was sent.");
      });
      expect(screen.getByRole("button", { name: "Retry funding" })).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/bind"))).toBe(false);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps unexpected wallet failures visible and retryable", async () => {
    mockFundingFlow();
    sendTransactionMock.mockRejectedValueOnce(new Error("Wallet bridge unavailable"));
    render(<RewardFundingPanel pollId="poll-qa" />);

    fireEvent.click(await screen.findByRole("button", { name: "Fund reward campaign" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Wallet bridge unavailable");
    });
    expect(screen.getByRole("button", { name: "Retry funding" })).toBeInTheDocument();
  });

  it("can retry funding after a cancellation", async () => {
    mockFundingFlow();
    sendTransactionMock
      .mockRejectedValueOnce({ code: 4001, message: "User rejected the request." })
      .mockResolvedValueOnce({ transactionHash: "a".repeat(64) });
    render(<RewardFundingPanel pollId="poll-qa" />);

    fireEvent.click(await screen.findByRole("button", { name: "Fund reward campaign" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Funding cancelled. No transaction was sent."));

    fireEvent.click(screen.getByRole("button", { name: "Retry funding" }));
    await waitFor(() => expect(sendTransactionMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
