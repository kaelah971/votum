import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClaimNimButton } from "@/components/campaign/ClaimNimButton";
import type { ClaimPhase, CampaignClaimReceipt } from "@/hooks/useCampaignClaim";

const mocks = vi.hoisted(() => ({
  claim: {
    phase: "idle" as ClaimPhase,
    receipt: null as CampaignClaimReceipt | null,
    errorCode: null as string | null,
    start: vi.fn(),
    reset: vi.fn(),
  },
  session: {
    isSessionVerified: true,
    isWalletMatched: true,
  },
}));

vi.mock("@/hooks/useCampaignClaim", () => ({
  useCampaignClaim: () => mocks.claim,
}));

vi.mock("@/providers/VotumSessionProvider", () => ({
  useVotumSession: () => mocks.session,
}));

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  mocks.claim = {
    phase: "idle",
    receipt: null,
    errorCode: null,
    start: vi.fn(),
    reset: vi.fn(),
  };
  mocks.session = { isSessionVerified: true, isWalletMatched: true };
});

describe("ClaimNimButton", () => {
  it("renders the idle CTA and starts the claim flow", () => {
    render(<ClaimNimButton campaignId={CAMPAIGN} />);
    const button = screen.getByRole("button", { name: "Claim NIM" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(mocks.claim.start).toHaveBeenCalledTimes(1);
  });

  it("labels each loading phase distinctly and disables interaction", () => {
    for (const [phase, label] of [
      ["requesting_challenge", "Requesting claim challenge"],
      ["awaiting_signature", "Confirm in your wallet"],
      ["submitting_claim", "Reserving your reward"],
    ] as const) {
      mocks.claim = { ...mocks.claim, phase };
      const { unmount } = render(<ClaimNimButton campaignId={CAMPAIGN} />);
      const button = screen.getByRole("button", { name: label });
      expect(button).toBeDisabled();
      unmount();
    }
  });

  it("disables the CTA while the session is unverified or mismatched", () => {
    mocks.session = { isSessionVerified: false, isWalletMatched: false };
    const { unmount } = render(<ClaimNimButton campaignId={CAMPAIGN} />);
    expect(screen.getByRole("button", { name: "Claim NIM" })).toBeDisabled();
    unmount();

    mocks.session = { isSessionVerified: true, isWalletMatched: false };
    render(<ClaimNimButton campaignId={CAMPAIGN} />);
    expect(screen.getByRole("button", { name: "Claim NIM" })).toBeDisabled();
  });

  it("shows reservation copy without implying payment unless paid", () => {
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
    const { container, unmount } = render(<ClaimNimButton campaignId={CAMPAIGN} />);
    expect(screen.getByText("Reward reserved")).toBeTruthy();
    expect(container.textContent).not.toMatch(/paid/i);
    unmount();

    mocks.claim = {
      ...mocks.claim,
      phase: "done",
      receipt: {
        receiptId: "receipt-1",
        settlementId: "settlement-1",
        status: "reserved",
        replayed: true,
      },
    };
    render(<ClaimNimButton campaignId={CAMPAIGN} />);
    expect(screen.getByText("Already reserved")).toBeTruthy();
  });

  it("shows deterministic error copy with a safe restart action", () => {
    mocks.claim = { ...mocks.claim, phase: "error", errorCode: "sold_out" };
    render(<ClaimNimButton campaignId={CAMPAIGN} />);
    expect(screen.getByText("Sold out")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.claim.reset).toHaveBeenCalledTimes(1);
  });

  it("exposes no payout retry, resend, or broadcast control", () => {
    mocks.claim = {
      ...mocks.claim,
      phase: "done",
      receipt: {
        receiptId: "receipt-1",
        settlementId: "settlement-1",
        status: "payout_pending",
        replayed: false,
      },
    };
    const { container } = render(<ClaimNimButton campaignId={CAMPAIGN} />);
    expect(container.textContent).not.toMatch(/retry|resend|broadcast|send again/i);
    expect(screen.queryByRole("button", { name: "Claim NIM" })).toBeNull();
  });
});
