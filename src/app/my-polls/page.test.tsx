import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import MyPollsPage from "@/app/my-polls/page";

const mocks = vi.hoisted(() => ({
  session: {
    isSessionVerified: true,
    verifyActiveWallet: vi.fn(),
  },
  nimiq: {
    walletStatus: "connected",
    isInsideNimiqPay: true,
  },
  onboarding: {
    open: false,
    state: "connected",
    intent: null,
    verifiedWalletAddress: null,
    profileReady: false,
    openOnboarding: vi.fn(),
    closeOnboarding: vi.fn(),
  },
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/my-polls",
}));

vi.mock("@/providers/VotumSessionProvider", () => ({
  useVotumSession: () => mocks.session,
}));

vi.mock("@/providers/NimiqProvider", () => ({
  useNimiqContext: () => mocks.nimiq,
}));

vi.mock("@/providers/OnboardingProvider", () => ({
  useOnboarding: () => mocks.onboarding,
}));

const pollBase = {
  id: "poll-1",
  question: "Which reward should this poll offer?",
  status: "live",
  isPublic: true,
  createdAt: "2026-08-31T00:00:00.000Z",
  optionCount: 2,
};

const rewardCampaign = {
  state: "configured",
  rewardPerParticipantNim: "0.01 NIM",
  maxRewardedParticipants: 1,
  rewardPrincipalNim: "0.01 NIM",
  feeReserveNim: "0.08 NIM",
  totalRequiredFundingNim: "0.09 NIM",
};

function mockPolls(poll: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ polls: [poll] }),
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("/my-polls reward funding entry", () => {
  it("shows Fund rewards for a configured rewarded campaign", async () => {
    mockPolls({
      ...pollBase,
      economicModel: "reward_first",
      rewardMode: "rewarded",
      rewardCampaign,
    });
    render(<MyPollsPage />);

    const action = await waitFor(() => screen.getByRole("link", { name: /Fund rewards/ }));
    expect(action).toHaveAttribute("href", "/my-polls/poll-1");
    expect(action).toHaveTextContent("0.09 NIM");
  });

  it("shows pending funding without offering a duplicate fund action", async () => {
    mockPolls({
      ...pollBase,
      economicModel: "reward_first",
      rewardMode: "rewarded",
      rewardCampaign: { ...rewardCampaign, state: "funding_pending" },
    });
    render(<MyPollsPage />);

    await waitFor(() => expect(screen.getByText(/Funding submitted/)).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /Fund rewards|Complete funding/ })).not.toBeInTheDocument();
  });

  it("shows funded state without a Fund action", async () => {
    mockPolls({
      ...pollBase,
      economicModel: "reward_first",
      rewardMode: "rewarded",
      rewardCampaign: { ...rewardCampaign, state: "funded" },
    });
    render(<MyPollsPage />);

    await waitFor(() => expect(screen.getByText("Rewards funded")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /Fund rewards|Complete funding/ })).not.toBeInTheDocument();
  });

  it("does not show a funding action for free verified polls", async () => {
    mockPolls({
      ...pollBase,
      economicModel: "reward_first",
      rewardMode: "free",
      rewardCampaign: null,
    });
    render(<MyPollsPage />);

    await waitFor(() => expect(screen.getByText("Free verified")).toBeInTheDocument());
    expect(screen.queryByText(/Fund rewards|Complete funding/)).not.toBeInTheDocument();
  });

  it("does not reinterpret legacy support polls as reward funding", async () => {
    mockPolls({
      ...pollBase,
      economicModel: "legacy_support",
      rewardMode: null,
      rewardCampaign,
    });
    render(<MyPollsPage />);

    await waitFor(() => expect(screen.getByText("Legacy support")).toBeInTheDocument());
    expect(screen.queryByText(/Fund rewards|Complete funding/)).not.toBeInTheDocument();
  });
});
