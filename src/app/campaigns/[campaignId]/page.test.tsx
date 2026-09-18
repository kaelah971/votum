import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const OWNER = "01" + "a".repeat(38);
const PARTICIPANT = "02" + "b".repeat(38);

const mocks = vi.hoisted(() => ({
  session: null as { address: string } | null,
  giveaway: null as Record<string, unknown> | null,
  binding: { kind: "ok", ownerWallet: "01" + "a".repeat(38) } as Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ marker: "admin" }),
  getAdminConfigStatus: () => ({ configured: true }),
}));

vi.mock("@/lib/campaigns/public-giveaway", () => ({
  getPublicCampaignGiveaway: () => mocks.giveaway,
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/campaigns/settlement", () => ({
  resolveCampaignRewardSettlement: () => mocks.binding,
}));

vi.mock("@/components/campaign/CampaignClaimSection", () => ({
  CampaignClaimSection: (props: Record<string, unknown>) => (
    <div
      data-testid="claim-section"
      data-claim-state={props.claimState as string}
      data-viewer-is-creator={String(props.viewerIsCreator)}
    />
  ),
}));

vi.mock("@/providers/VotumSessionProvider", () => ({
  useVotumSession: () => ({
    status: "unverified",
    verifiedWalletAddress: null,
    isSessionVerified: false,
    isWalletMatched: false,
    verifyActiveWallet: vi.fn(),
    endVerifiedSession: vi.fn(),
    refreshSession: vi.fn(),
  }),
}));

vi.mock("@/providers/NimiqProvider", () => ({
  useNimiqContext: () => ({
    provider: null,
    activeAccount: null,
    isInsideNimiqPay: false,
  }),
}));

vi.mock("@/providers/OnboardingProvider", () => ({
  useOnboarding: () => ({
    openOnboarding: vi.fn(),
    closeOnboarding: vi.fn(),
  }),
}));

import CampaignPage from "@/app/campaigns/[campaignId]/page";

function dto(overrides: Record<string, unknown> = {}) {
  return {
    campaignId: "campaign-1",
    campaignType: "public_giveaway",
    visibility: "public",
    title: "Neighborhood cleanup reward",
    description: "Join the Saturday cleanup.",
    creatorDisplay: "NQ32 4Y...b845",
    startsAt: null,
    endsAt: null,
    claimState: "open",
    published: true,
    fundingReady: true,
    rewardPerParticipantNim: "0.5 NIM",
    maxRewardedParticipants: 10,
    remainingRewards: 7,
    reservedCount: 0,
    paidCount: 0,
    ...overrides,
  };
}

function context() {
  return { params: Promise.resolve({ campaignId: "campaign-1" }) };
}

beforeEach(() => {
  mocks.session = null;
  mocks.giveaway = dto();
  mocks.binding = { kind: "ok", ownerWallet: OWNER };
});

describe("CampaignPage claim composition", () => {
  it("passes the public DTO and claim slot into the giveaway view", async () => {
    const page = await CampaignPage(context());
    render(page);
    expect(screen.getByText("Neighborhood cleanup reward")).toBeTruthy();
    const section = screen.getByTestId("claim-section");
    expect(section.getAttribute("data-claim-state")).toBe("open");
    expect(section.getAttribute("data-viewer-is-creator")).toBe("false");
  });

  it("marks the viewer as creator only for the owner session", async () => {
    mocks.session = { address: OWNER };
    const ownerPage = await CampaignPage(context());
    const { unmount } = render(ownerPage);
    expect(screen.getByTestId("claim-section").getAttribute("data-viewer-is-creator")).toBe("true");
    unmount();

    mocks.session = { address: PARTICIPANT };
    const participantPage = await CampaignPage(context());
    render(participantPage);
    expect(screen.getByTestId("claim-section").getAttribute("data-viewer-is-creator")).toBe("false");
  });

  it("renders unavailable states for unknown campaigns", async () => {
    mocks.giveaway = null;
    await expect(CampaignPage(context())).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("propagates non-open claim states into the claim section", async () => {
    for (const claimState of ["needs_funding", "starts_soon", "full", "ended", "closed", "unpublished"]) {
      mocks.giveaway = dto({ claimState });
      const page = await CampaignPage(context());
      const { unmount } = render(page);
      expect(screen.getByTestId("claim-section").getAttribute("data-claim-state")).toBe(claimState);
      unmount();
    }
  });
});
