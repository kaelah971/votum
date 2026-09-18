import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CampaignClaimSection } from "@/components/campaign/CampaignClaimSection";
import type { CampaignClaimReceipt } from "@/hooks/useCampaignClaim";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";

interface SessionMock {
  status: string;
  verifiedWalletAddress: string | null;
  isSessionVerified: boolean;
  isWalletMatched: boolean;
  verifyActiveWallet: Mock;
}

interface ClaimMock {
  phase: string;
  receipt: CampaignClaimReceipt | null;
  errorCode: string | null;
  start: Mock;
  reset: Mock;
}

const mocks = vi.hoisted(() => ({
  session: {
    status: "verified",
    verifiedWalletAddress: "02" + "b".repeat(38),
    isSessionVerified: true,
    isWalletMatched: true,
    verifyActiveWallet: vi.fn(),
  } as SessionMock,
  claim: {
    phase: "idle",
    receipt: null,
    errorCode: null,
    start: vi.fn(),
    reset: vi.fn(),
  } as ClaimMock,
  claimStatus: vi.fn(),
}));

vi.mock("@/providers/VotumSessionProvider", () => ({
  useVotumSession: () => mocks.session,
}));

vi.mock("@/providers/NimiqProvider", () => ({
  useNimiqContext: () => ({
    provider: { marker: "provider" },
    activeAccount: "02" + "b".repeat(38),
  }),
}));

vi.mock("@/hooks/useCampaignClaim", () => ({
  useCampaignClaim: () => mocks.claim,
}));

vi.mock("@/components/campaign/CampaignClaimStatus", () => ({
  CampaignClaimStatus: (props: Record<string, unknown>) => {
    mocks.claimStatus(props);
    return <div data-testid="claim-status" />;
  },
}));

vi.mock("@/components/ui/WalletButton", () => ({
  WalletButton: () => <div data-testid="wallet-button" />,
}));

function verifiedSession() {
  mocks.session = {
    status: "verified",
    verifiedWalletAddress: "02" + "b".repeat(38),
    isSessionVerified: true,
    isWalletMatched: true,
    verifyActiveWallet: vi.fn(),
  };
}

beforeEach(() => {
  verifiedSession();
  mocks.claim = {
    phase: "idle",
    receipt: null,
    errorCode: null,
    start: vi.fn(),
    reset: vi.fn(),
  };
  mocks.claimStatus.mockReset();
});

describe("CampaignClaimSection", () => {
  it("shows the claim CTA to a verified matched participant on open campaigns", () => {
    render(<CampaignClaimSection campaignId={CAMPAIGN} claimState="open" viewerIsCreator={false} />);
    expect(screen.getByRole("button", { name: "Claim NIM" })).toBeEnabled();
    expect(screen.getByTestId("claim-status")).toBeTruthy();
  });

  it("hides the CTA once a claim is known and shows status instead", () => {
    render(
      <CampaignClaimSection campaignId={CAMPAIGN} claimState="open" viewerIsCreator={false} />,
    );
    expect(screen.getByRole("button", { name: "Claim NIM" })).toBeTruthy();

    const onClaimedChange = mocks.claimStatus.mock.calls[0][0].onClaimedChange as (claimed: boolean) => void;
    act(() => {
      onClaimedChange(true);
    });
    expect(screen.queryByRole("button", { name: "Claim NIM" })).toBeNull();
    expect(screen.getByTestId("claim-status")).toBeTruthy();
  });

  it("never offers claim to the creator", () => {
    render(<CampaignClaimSection campaignId={CAMPAIGN} claimState="open" viewerIsCreator={true} />);
    expect(screen.queryByRole("button", { name: "Claim NIM" })).toBeNull();
    expect(screen.getByText("Your campaign")).toBeTruthy();
    expect(screen.queryByText("Close campaign")).toBeNull();
    expect(screen.queryByText("Refund")).toBeNull();
  });

  it("shows no CTA for non-open lifecycle states", () => {
    for (const claimState of ["needs_funding", "starts_soon", "full", "ended", "closed", "unpublished"] as const) {
      const { unmount } = render(
        <CampaignClaimSection campaignId={CAMPAIGN} claimState={claimState} viewerIsCreator={false} />,
      );
      expect(screen.queryByRole("button", { name: "Claim NIM" })).toBeNull();
      unmount();
    }
  });

  it("guides disconnected and mismatched wallets without an enabled CTA", () => {
    mocks.session = {
      status: "unverified",
      verifiedWalletAddress: null,
      isSessionVerified: false,
      isWalletMatched: false,
      verifyActiveWallet: vi.fn(),
    };
    const { unmount } = render(
      <CampaignClaimSection campaignId={CAMPAIGN} claimState="open" viewerIsCreator={false} />,
    );
    expect(screen.getByTestId("wallet-button")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Claim NIM" })).toBeNull();
    unmount();

    verifiedSession();
    mocks.session = { ...mocks.session, status: "verified_wallet_mismatch", isWalletMatched: false };
    render(<CampaignClaimSection campaignId={CAMPAIGN} claimState="open" viewerIsCreator={false} />);
    expect(screen.getByText("Wallet mismatch", { exact: false })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Claim NIM" })).toBeNull();
  });

  it("forwards successful claims into an immediate status refresh", () => {
    const { rerender } = render(
      <CampaignClaimSection campaignId={CAMPAIGN} claimState="open" viewerIsCreator={false} />,
    );
    const initialSignal = mocks.claimStatus.mock.calls[0][0].refreshSignal as number;
    fireEvent.click(screen.getByRole("button", { name: "Claim NIM" }));
    expect(mocks.claim.start).toHaveBeenCalledTimes(1);

    mocks.claim = {
      ...mocks.claim,
      phase: "done",
      receipt: {
        receiptId: "receipt-1",
        settlementId: "settlement-1",
        status: "reserved",
        replayed: false,
      },
    };
    rerender(
      <CampaignClaimSection campaignId={CAMPAIGN} claimState="open" viewerIsCreator={false} />,
    );
    const calls = mocks.claimStatus.mock.calls;
    const latestSignal = (calls[calls.length - 1][0] as { refreshSignal: number }).refreshSignal;
    expect(latestSignal).toBeGreaterThan(initialSignal);
    expect(screen.queryByRole("button", { name: "Claim NIM" })).toBeNull();
  });
});
