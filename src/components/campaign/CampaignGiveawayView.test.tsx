import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CampaignGiveawayView } from "@/components/campaign/CampaignGiveawayView";
import type { PublicCampaignGiveaway } from "@/lib/campaigns/public-giveaway";

function dto(overrides: Partial<PublicCampaignGiveaway> = {}): PublicCampaignGiveaway {
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
    expect(screen.getByText("Created by", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("NQ32 4Y...b845")).toBeInTheDocument();
    expect(screen.queryByText("01" + "a".repeat(38))).toBeNull();
    const html = container.innerHTML;
    for (const token of PRIVATE_TOKENS) {
      expect(html).not.toContain(token);
    }
  });

  it("renders open state with a claim slot and no placeholder of its own", () => {
    const bare = render(<CampaignGiveawayView giveaway={dto()} />);
    expect(bare.container.querySelector("button")).toBeNull();
    expect(bare.container.querySelector("a")).toBeNull();
    expect(bare.container.querySelector('[role="button"]')).toBeNull();
    expect(screen.queryByText("Claim NIM")).toBeNull();
    expect(screen.queryByText("Claims are not available yet.")).toBeNull();
    bare.unmount();

    const slotted = render(
      <CampaignGiveawayView
        giveaway={dto()}
        claimSlot={<button type="button">Claim NIM</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Claim NIM" })).toBeInTheDocument();
    slotted.unmount();

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
