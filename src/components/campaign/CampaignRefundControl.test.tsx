import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CampaignRefundControl } from "@/components/campaign/CampaignRefundControl";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  refund: vi.fn(),
}));

vi.mock("@/lib/campaigns/creator-client", () => ({
  refundCampaign: mocks.refund,
}));

beforeEach(() => {
  mocks.refund.mockReset();
});

describe("CampaignRefundControl — visibility", () => {
  it("renders nothing before close", () => {
    for (const status of [null, "draft", "published", "expired", "cancelled"]) {
      const { container, unmount } = render(
        <CampaignRefundControl campaignId={CAMPAIGN} campaignStatus={status} />,
      );
      expect(container.firstChild).toBeNull();
      unmount();
    }
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it("offers the refund action once closed", () => {
    render(<CampaignRefundControl campaignId={CAMPAIGN} campaignStatus="closed" />);
    expect(
      screen.getByRole("button", { name: "Refund remaining NIM" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The unused remainder becomes refundable only after participant obligations settle.", {
        exact: false,
      }),
    ).toBeInTheDocument();
  });
});

describe("CampaignRefundControl — refund flow", () => {
  it("calls refundCampaign exactly once with the campaign id", async () => {
    mocks.refund.mockResolvedValue({
      kind: "processed",
      refundId: "refund-1",
      status: "broadcasted",
      transactionHash: "ab".repeat(32),
    });
    render(<CampaignRefundControl campaignId={CAMPAIGN} campaignStatus="closed" />);

    fireEvent.click(screen.getByRole("button", { name: "Refund remaining NIM" }));
    await waitFor(() => expect(mocks.refund).toHaveBeenCalledWith(CAMPAIGN));
    expect(mocks.refund).toHaveBeenCalledTimes(1);
  });

  it("shows a loading state while preparing", async () => {
    let resolveRefund!: (value: { kind: "refunded" }) => void;
    mocks.refund.mockReturnValue(
      new Promise((resolve) => {
        resolveRefund = resolve;
      }),
    );
    render(<CampaignRefundControl campaignId={CAMPAIGN} campaignStatus="closed" />);

    fireEvent.click(screen.getByRole("button", { name: "Refund remaining NIM" }));
    expect(
      await screen.findByRole("button", { name: "Preparing refund…" }),
    ).toBeDisabled();

    resolveRefund({ kind: "refunded" });
    expect(await screen.findByText("Refunded")).toBeInTheDocument();
  });

  it("explains blocked obligations without a resend control", async () => {
    mocks.refund.mockResolvedValue({
      kind: "error",
      error: { code: "unresolved_reward_obligations", status: 409 },
    });
    render(<CampaignRefundControl campaignId={CAMPAIGN} campaignStatus="closed" />);

    fireEvent.click(screen.getByRole("button", { name: "Refund remaining NIM" }));
    expect(
      await screen.findByText("Refund blocked — participant payouts are still being settled.", {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Could not prepare the refund (unresolved_reward_obligations).", {
        exact: false,
      }),
    ).toBeInTheDocument();
    // Safe idempotent retry stays available; transport resend never exists.
    expect(
      screen.getByRole("button", { name: "Refund remaining NIM" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: /resend|rebroadcast|send again/i })).toBeNull();
  });

  it("shows the terminal refunded state without inviting another refund", async () => {
    mocks.refund.mockResolvedValue({ kind: "refunded" });
    render(<CampaignRefundControl campaignId={CAMPAIGN} campaignStatus="closed" />);

    fireEvent.click(screen.getByRole("button", { name: "Refund remaining NIM" }));
    expect(await screen.findByText("Refunded")).toBeInTheDocument();
    expect(
      screen.getByText("Refunded — nothing remaining.", { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Refund remaining NIM" }),
    ).toBeNull();
  });

  it("shows processing after broadcast with no amount arithmetic", async () => {
    mocks.refund.mockResolvedValue({
      kind: "processed",
      refundId: "refund-1",
      status: "broadcasted",
      transactionHash: "ab".repeat(32),
    });
    const { container } = render(
      <CampaignRefundControl campaignId={CAMPAIGN} campaignStatus="closed" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refund remaining NIM" }));
    expect(await screen.findByText("Processing")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /refund/i })).toBeNull();
    // No client-side amount is ever displayed or derived.
    expect(container.textContent).not.toMatch(/\d+\.\d+ NIM/);
    expect(container.textContent).not.toMatch(/Luna/);
  });
});
