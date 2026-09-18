import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CampaignManageView } from "@/components/campaign/CampaignManageView";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  readiness: vi.fn(),
  publicCampaign: vi.fn(),
  fundingProps: vi.fn(),
  publishProps: vi.fn(),
  closeProps: vi.fn(),
  refundProps: vi.fn(),
  writeText: vi.fn(),
  session: {
    isSessionVerified: true,
    isWalletMatched: true,
  },
  nimiq: {
    walletStatus: "connected",
  },
  onboarding: {
    openOnboarding: vi.fn(),
  },
}));

vi.mock("@/lib/campaigns/creator-client", () => ({
  getCampaignFundingReadiness: mocks.readiness,
  getPublicCampaign: mocks.publicCampaign,
}));

vi.mock("@/components/campaign/CampaignFundingPanel", () => ({
  CampaignFundingPanel: (props: Record<string, unknown>) => {
    mocks.fundingProps(props);
    return <div data-testid="funding-panel" />;
  },
}));

vi.mock("@/components/campaign/CampaignPublishControl", () => ({
  CampaignPublishControl: (props: Record<string, unknown>) => {
    mocks.publishProps(props);
    return <div data-testid="publish-control" />;
  },
}));

vi.mock("@/components/campaign/CampaignCloseControl", () => ({
  CampaignCloseControl: (props: Record<string, unknown>) => {
    mocks.closeProps(props);
    return <div data-testid="close-control" />;
  },
}));

vi.mock("@/components/campaign/CampaignRefundControl", () => ({
  CampaignRefundControl: (props: Record<string, unknown>) => {
    mocks.refundProps(props);
    return <div data-testid="refund-control" />;
  },
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

vi.mock("next/navigation", () => ({
  usePathname: () => `/campaigns/${CAMPAIGN}/manage`,
}));

function readinessResponse(
  campaign: Record<string, unknown> = {},
  fundingReadiness: Record<string, unknown> = {},
) {
  return {
    kind: "loaded",
    campaign: {
      campaignId: CAMPAIGN,
      campaignType: "public_giveaway",
      visibility: "public",
      title: "Neighborhood cleanup reward",
      description: "Rewarding verified cleanup participation.",
      status: "draft",
      startsAt: null,
      endsAt: null,
      reward: { rewardPerParticipantNim: "0.5" },
      ...campaign,
    },
    fundingReadiness: {
      ready: false,
      reason: "ready_for_funding",
      settlementStatus: "configured",
      fundedAmountLuna: "0",
      requiredAmountLuna: "580000",
      vaultReady: true,
      ...fundingReadiness,
    },
  };
}

function publicResponse(dto: Record<string, unknown> = {}) {
  return {
    kind: "loaded",
    campaign: {
      campaignId: CAMPAIGN,
      claimState: "open",
      remainingRewards: 7,
      reservedCount: 2,
      paidCount: 1,
      maxRewardedParticipants: 10,
      rewardPerParticipantNim: "0.5",
      startsAt: null,
      endsAt: null,
      visibility: "public",
      ...dto,
    },
  };
}

function mockLoaded() {
  mocks.readiness.mockResolvedValue(readinessResponse());
  mocks.publicCampaign.mockResolvedValue(publicResponse());
}

beforeEach(() => {
  mocks.session.isSessionVerified = true;
  mocks.session.isWalletMatched = true;
  mocks.nimiq.walletStatus = "connected";
  mocks.readiness.mockReset();
  mocks.publicCampaign.mockReset();
  mocks.fundingProps.mockClear();
  mocks.publishProps.mockClear();
  mocks.closeProps.mockClear();
  mocks.refundProps.mockClear();
  mocks.writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: mocks.writeText },
    configurable: true,
  });
});

describe("CampaignManageView — loading and gating", () => {
  it("gates unverified visitors before loading anything", () => {
    mocks.session.isSessionVerified = false;
    mocks.session.isWalletMatched = false;
    mocks.nimiq.walletStatus = "disconnected";
    render(<CampaignManageView campaignId={CAMPAIGN} />);

    expect(
      screen.getByRole("button", { name: "Connect wallet" }),
    ).toBeInTheDocument();
    expect(mocks.readiness).not.toHaveBeenCalled();
  });

  it("loads campaign readiness and the public aggregate DTO", async () => {
    mockLoaded();
    render(<CampaignManageView campaignId={CAMPAIGN} />);

    expect(await screen.findByRole("heading", { name: "Neighborhood cleanup reward" })).toBeInTheDocument();
    expect(mocks.readiness).toHaveBeenCalledWith(CAMPAIGN);
    expect(mocks.publicCampaign).toHaveBeenCalledWith(CAMPAIGN);
  });
});

describe("CampaignManageView — terms, status, and stats", () => {
  it("renders campaign terms and lifecycle status", async () => {
    mockLoaded();
    render(<CampaignManageView campaignId={CAMPAIGN} />);

    expect(await screen.findByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Rewarding verified cleanup participation.")).toBeInTheDocument();
    expect(screen.getByText("0.5 NIM")).toBeInTheDocument();
    expect(screen.getByText("Untimed")).toBeInTheDocument();
    expect(screen.getByText("Participant view: open")).toBeInTheDocument();
  });

  it("renders aggregate counts without any participant wallet list", async () => {
    mockLoaded();
    const { container } = render(<CampaignManageView campaignId={CAMPAIGN} />);

    expect(await screen.findByText("Remaining rewards")).toBeInTheDocument();
    expect(screen.getByText("Reserved")).toBeInTheDocument();
    expect(screen.getByText("Paid")).toBeInTheDocument();
    // Counts only — no wallets, vaults, or rosters anywhere on the page.
    expect(container.textContent).not.toMatch(/NQ[0-9A-Z]/);
    expect(container.querySelector("[data-testid='wallet-list']")).toBeNull();
  });

  it("withholds actionable funding on drafts until published", async () => {
    mockLoaded();
    render(<CampaignManageView campaignId={CAMPAIGN} />);

    await screen.findByRole("heading", { name: "Neighborhood cleanup reward" });
    expect(screen.getByTestId("publish-control")).toBeInTheDocument();
    expect(screen.queryByTestId("funding-panel")).toBeNull();
    expect(
      screen.getByText("Publish this giveaway first — funding opens once it is published."),
    ).toBeInTheDocument();
    expect(mocks.fundingProps).not.toHaveBeenCalled();
  });

  it("shows the funding panel once published", async () => {
    mocks.readiness.mockResolvedValue(readinessResponse({ status: "published" }));
    mocks.publicCampaign.mockResolvedValue(publicResponse());
    render(<CampaignManageView campaignId={CAMPAIGN} />);

    await screen.findByRole("heading", { name: "Neighborhood cleanup reward" });
    expect(screen.getByTestId("funding-panel")).toBeInTheDocument();
    expect(
      screen.queryByText("Publish this giveaway first — funding opens once it is published."),
    ).toBeNull();
  });

  it("omits stats gracefully when the public DTO is unavailable", async () => {    mocks.readiness.mockResolvedValue(readinessResponse());
    mocks.publicCampaign.mockResolvedValue({
      kind: "error",
      error: { code: "campaign_not_found", status: 404 },
    });
    render(<CampaignManageView campaignId={CAMPAIGN} />);

    expect(await screen.findByRole("heading", { name: "Neighborhood cleanup reward" })).toBeInTheDocument();
    expect(screen.queryByText("Remaining rewards")).toBeNull();
    expect(screen.getByTestId("publish-control")).toBeInTheDocument();
  });
});

describe("CampaignManageView — composition", () => {
  it("passes the server status and campaign id into each control", async () => {
    mockLoaded();
    render(<CampaignManageView campaignId={CAMPAIGN} />);

    await screen.findByRole("heading", { name: "Neighborhood cleanup reward" });
    expect(mocks.fundingProps).not.toHaveBeenCalled();
    expect(mocks.publishProps).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, campaignStatus: "draft" }),
    );
    expect(mocks.closeProps).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, campaignStatus: "draft" }),
    );
    expect(mocks.refundProps).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, campaignStatus: "draft" }),
    );
  });

  it("propagates publish and close updates into every control", async () => {
    mockLoaded();
    render(<CampaignManageView campaignId={CAMPAIGN} />);
    await screen.findByRole("heading", { name: "Neighborhood cleanup reward" });

    const onPublished = mocks.publishProps.mock.calls.at(-1)?.[0]
      ?.onPublished as (campaign: unknown) => void;
    act(() => {
      onPublished({ campaignId: CAMPAIGN, status: "published" });
    });
    expect(mocks.publishProps.mock.calls.at(-1)?.[0]).toMatchObject({
      campaignStatus: "published",
    });
    expect(mocks.closeProps.mock.calls.at(-1)?.[0]).toMatchObject({
      campaignStatus: "published",
    });

    const onClosed = mocks.closeProps.mock.calls.at(-1)?.[0]
      ?.onClosed as () => void;
    act(() => {
      onClosed();
    });
    expect(mocks.publishProps.mock.calls.at(-1)?.[0]).toMatchObject({
      campaignStatus: "closed",
    });
    expect(mocks.closeProps.mock.calls.at(-1)?.[0]).toMatchObject({
      campaignStatus: "closed",
    });
    expect(mocks.refundProps.mock.calls.at(-1)?.[0]).toMatchObject({
      campaignId: CAMPAIGN,
      campaignStatus: "closed",
    });
  });
});

describe("CampaignManageView — share link", () => {
  it("shows the canonical public link and copies it on demand", async () => {
    mockLoaded();
    render(<CampaignManageView campaignId={CAMPAIGN} />);

    const path = `/campaigns/${CAMPAIGN}`;
    expect(await screen.findByText(path)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

    expect(mocks.writeText).toHaveBeenCalledWith(
      `${window.location.origin}${path}`,
    );
    expect(await screen.findByText("Link copied.")).toBeInTheDocument();
  });
});

describe("CampaignManageView — access errors", () => {
  it("explains forbidden, missing, and session states concisely", async () => {
    for (const [status, copy] of [
      [403, "Only the giveaway owner can manage this giveaway."],
      [404, "Giveaway not found."],
      [401, "Your verified wallet session has expired."],
    ] as const) {
      mocks.readiness.mockReset();
      mocks.readiness.mockResolvedValue({
        kind: "error",
        error: { code: "forbidden", status },
      });
      const { unmount } = render(<CampaignManageView campaignId={CAMPAIGN} />);
      expect(await screen.findByText(copy, { exact: false })).toBeInTheDocument();
      expect(screen.queryByTestId("funding-panel")).toBeNull();
      unmount();
    }
  });
});
