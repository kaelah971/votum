import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CampaignGiveawayView } from "@/components/campaign/CampaignGiveawayView";
import type { PublicCampaignGiveaway } from "@/lib/campaigns/public-giveaway";

function dto(overrides: Partial<PublicCampaignGiveaway> = {}): PublicCampaignGiveaway {
  return {
    campaignId: "campaign-1",
    campaignType: "public_giveaway",
    visibility: "public",
    title: "Neighborhood cleanup reward",
    description: "Join the Saturday cleanup.",
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

const PRIVATE_TOKENS = [
  "participant_wallet",
  "nonce",
  "ciphertext",
  "private",
  "token",
  "lease",
  "prepared",
  "refund",
  "vault",
  "challenge",
];

describe("CampaignGiveawayView", () => {
  it("renders identity, terms, counts, and fairness without wallet data", () => {
    const { container } = render(<CampaignGiveawayView giveaway={dto()} />);

    expect(screen.getByText("Neighborhood cleanup reward")).toBeInTheDocument();
    expect(screen.getByText("0.5 NIM")).toBeInTheDocument();
    expect(screen.getByText("7 of 10")).toBeInTheDocument();
    expect(screen.getByText("One wallet · one claim")).toBeInTheDocument();
    const html = container.innerHTML;
    for (const token of PRIVATE_TOKENS) {
      expect(html).not.toContain(token);
    }
  });

  it("reserves a disabled, non-actionable Claim NIM slot only when open", () => {
    const { unmount } = render(<CampaignGiveawayView giveaway={dto()} />);
    const button = screen.getByRole("button", { name: "Claim NIM" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByText("Claiming is not available yet.")).toBeInTheDocument();
    unmount();

    render(<CampaignGiveawayView giveaway={dto({ claimState: "needs_funding" })} />);
    expect(screen.queryByRole("button", { name: "Claim NIM" })).toBeNull();
    expect(screen.getByText("Funding pending")).toBeInTheDocument();
  });

  it.each([
    ["needs_funding", "Funding pending"],
    ["starts_soon", "Starts at"],
    ["full", "Sold out"],
    ["ended", "Ended"],
    ["closed", "Closed"],
  ] as const)("represents the truthful %s state without implying claiming", (claimState, heading) => {
    render(
      <CampaignGiveawayView
        giveaway={dto({
          claimState,
          startsAt: claimState === "starts_soon" ? "2026-09-17T12:00:00.000Z" : null,
        })}
      />,
    );
    expect(screen.getByTestId("campaign-state-title").textContent ?? "").toMatch(
      new RegExp(`^${heading}`),
    );
    expect(screen.queryByRole("button", { name: "Claim NIM" })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
