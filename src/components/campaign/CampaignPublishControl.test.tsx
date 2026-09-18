import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CampaignPublishControl } from "@/components/campaign/CampaignPublishControl";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  onPublished: vi.fn(),
}));

vi.mock("@/lib/campaigns/creator-client", () => ({
  publishCampaign: mocks.publish,
}));

beforeEach(() => {
  mocks.publish.mockReset();
  mocks.onPublished.mockReset();
});

describe("CampaignPublishControl", () => {
  it("stays disabled with a reason while status is loading", () => {
    render(<CampaignPublishControl campaignId={CAMPAIGN} campaignStatus={null} />);

    expect(
      screen.getByRole("button", { name: "Publish giveaway" }),
    ).toBeDisabled();
    expect(screen.getByText("Loading campaign status…")).toBeInTheDocument();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("stays disabled with a reason once published", () => {
    render(
      <CampaignPublishControl campaignId={CAMPAIGN} campaignStatus="published" />,
    );

    expect(screen.getByText("Already published.")).toBeInTheDocument();
    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Publish giveaway" }),
    ).toBeNull();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("stays disabled for terminal lifecycle states", () => {
    for (const status of ["closed", "expired", "cancelled"]) {
      const { unmount } = render(
        <CampaignPublishControl campaignId={CAMPAIGN} campaignStatus={status} />,
      );
      expect(
        screen.getByRole("button", { name: "Publish giveaway" }),
      ).toBeDisabled();
      expect(
        screen.getByText("This giveaway can no longer be published."),
      ).toBeInTheDocument();
      unmount();
    }
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("publishes a draft with the exact campaign call", async () => {
    mocks.publish.mockResolvedValue({
      kind: "published",
      campaign: { campaignId: CAMPAIGN, status: "published" },
    });
    render(
      <CampaignPublishControl
        campaignId={CAMPAIGN}
        campaignStatus="draft"
        onPublished={mocks.onPublished}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish giveaway" }));
    await waitFor(() =>
      expect(mocks.publish).toHaveBeenCalledWith(CAMPAIGN),
    );
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it("shows a loading state while publishing", async () => {
    let resolvePublish!: (value: { kind: "published"; campaign: unknown }) => void;
    mocks.publish.mockReturnValue(
      new Promise((resolve) => {
        resolvePublish = resolve as typeof resolvePublish;
      }),
    );
    render(
      <CampaignPublishControl campaignId={CAMPAIGN} campaignStatus="draft" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish giveaway" }));
    expect(
      await screen.findByRole("button", { name: "Publishing…" }),
    ).toBeDisabled();

    resolvePublish({ kind: "published", campaign: { campaignId: CAMPAIGN } });
    expect(await screen.findByText("Giveaway published.")).toBeInTheDocument();
  });

  it("reports success and notifies the composer", async () => {
    const campaign = { campaignId: CAMPAIGN, status: "published" };
    mocks.publish.mockResolvedValue({ kind: "published", campaign });
    render(
      <CampaignPublishControl
        campaignId={CAMPAIGN}
        campaignStatus="draft"
        onPublished={mocks.onPublished}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish giveaway" }));
    expect(await screen.findByText("Giveaway published.")).toBeInTheDocument();
    expect(mocks.onPublished).toHaveBeenCalledWith(campaign);
  });

  it("shows lifecycle server errors inline with their code", async () => {
    mocks.publish.mockResolvedValue({
      kind: "error",
      error: { code: "immutable", status: 409, message: "This Campaign is already frozen." },
    });
    render(
      <CampaignPublishControl campaignId={CAMPAIGN} campaignStatus="draft" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish giveaway" }));
    expect(
      await screen.findByText("Could not publish (immutable).", { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Publish giveaway" }),
    ).toBeEnabled();
  });
});
