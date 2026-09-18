import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CampaignCloseControl } from "@/components/campaign/CampaignCloseControl";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const SETTLEMENT = "settlement-1";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  onClosed: vi.fn(),
}));

vi.mock("@/lib/campaigns/creator-client", () => ({
  closeCampaign: mocks.close,
}));

beforeEach(() => {
  mocks.close.mockReset();
  mocks.onClosed.mockReset();
});

describe("CampaignCloseControl — visibility", () => {
  it("offers closing for draft and published giveaways", () => {
    for (const status of ["draft", "published"]) {
      const { unmount } = render(
        <CampaignCloseControl campaignId={CAMPAIGN} campaignStatus={status} />,
      );
      expect(
        screen.getByRole("button", { name: "Close giveaway" }),
      ).toBeInTheDocument();
      unmount();
    }
  });

  it("renders nothing for terminal non-close states", () => {
    for (const status of ["expired", "cancelled"]) {
      const { container, unmount } = render(
        <CampaignCloseControl campaignId={CAMPAIGN} campaignStatus={status} />,
      );
      expect(container.firstChild).toBeNull();
      unmount();
    }
  });

  it("shows the Closed state without actions once closed", () => {
    render(<CampaignCloseControl campaignId={CAMPAIGN} campaignStatus="closed" />);
    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(
      screen.getByText("This giveaway is closed.", { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close giveaway" }),
    ).toBeNull();
  });
});

describe("CampaignCloseControl — confirmation and close", () => {
  it("requires explicit confirmation before calling close", () => {
    render(<CampaignCloseControl campaignId={CAMPAIGN} campaignStatus="published" />);

    fireEvent.click(screen.getByRole("button", { name: "Close giveaway" }));
    expect(mocks.close).not.toHaveBeenCalled();
    expect(screen.getByText("Close this giveaway now?")).toBeInTheDocument();
    expect(
      screen.getByText("Closing stops new claims immediately."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Already reserved participant rewards remain protected."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Existing payouts may continue."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The unused remainder can be refunded only after obligations settle.", {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it("closes with the exact campaign call and reports the Closed state", async () => {
    mocks.close.mockResolvedValue({ kind: "closed", settlementId: SETTLEMENT });
    render(
      <CampaignCloseControl
        campaignId={CAMPAIGN}
        campaignStatus="published"
        onClosed={mocks.onClosed}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close giveaway" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm close" }));

    await waitFor(() => expect(mocks.close).toHaveBeenCalledWith(CAMPAIGN));
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("This giveaway is closed.", { exact: false })).toBeInTheDocument();
    expect(mocks.onClosed).toHaveBeenCalledWith(SETTLEMENT);
  });

  it("shows a closing state while the request is in flight", async () => {
    let resolveClose!: (value: { kind: "closed"; settlementId: string }) => void;
    mocks.close.mockReturnValue(
      new Promise((resolve) => {
        resolveClose = resolve;
      }),
    );
    render(<CampaignCloseControl campaignId={CAMPAIGN} campaignStatus="draft" />);

    fireEvent.click(screen.getByRole("button", { name: "Close giveaway" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm close" }));
    expect(await screen.findByRole("button", { name: "Closing…" })).toBeDisabled();

    resolveClose({ kind: "closed", settlementId: SETTLEMENT });
    expect(await screen.findByText("This giveaway is closed.", { exact: false })).toBeInTheDocument();
  });

  it("displays server conflicts inline without closing", async () => {
    mocks.close.mockResolvedValue({
      kind: "error",
      error: { code: "campaign_state_conflict", status: 409 },
    });
    render(<CampaignCloseControl campaignId={CAMPAIGN} campaignStatus="published" />);

    fireEvent.click(screen.getByRole("button", { name: "Close giveaway" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm close" }));

    expect(
      await screen.findByText("Could not close (campaign_state_conflict).", {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(mocks.onClosed).not.toHaveBeenCalled();
  });

  it("exposes no refund action", () => {
    render(<CampaignCloseControl campaignId={CAMPAIGN} campaignStatus="published" />);
    expect(screen.queryByRole("button", { name: /refund/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close giveaway" }));
    expect(screen.queryByRole("button", { name: /refund/i })).toBeNull();
  });
});
