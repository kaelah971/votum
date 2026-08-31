import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { RewardFundingPanel } from "@/components/creator/RewardFundingPanel";

const mocks = vi.hoisted(() => ({
  nimiq: {
    provider: null,
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

vi.mock("@/lib/nimiq/client", () => ({
  sendBasicTransactionWithData: vi.fn(),
}));

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

beforeEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
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
});
