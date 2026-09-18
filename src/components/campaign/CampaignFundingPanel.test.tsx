import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CampaignFundingPanel } from "@/components/campaign/CampaignFundingPanel";
import { sendBasicTransactionWithData } from "@/lib/nimiq/client";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const INTENT = "33333333-3333-4333-8333-333333333333";
const VAULT_NQ = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
const HASH = "ab".repeat(32);

const mocks = vi.hoisted(() => ({
  readiness: vi.fn(),
  createIntent: vi.fn(),
  bind: vi.fn(),
  confirm: vi.fn(),
  nimiq: {
    provider: { marker: "provider" },
    isInsideNimiqPay: true,
    walletStatus: "connected",
  },
  session: {
    isSessionVerified: true,
    isWalletMatched: true,
  },
}));

vi.mock("@/lib/campaigns/creator-client", () => ({
  getCampaignFundingReadiness: mocks.readiness,
  createCampaignFundingIntent: mocks.createIntent,
  bindCampaignFunding: mocks.bind,
  confirmCampaignFunding: mocks.confirm,
}));

vi.mock("@/providers/NimiqProvider", () => ({
  useNimiqContext: () => mocks.nimiq,
}));

vi.mock("@/providers/VotumSessionProvider", () => ({
  useVotumSession: () => mocks.session,
}));

vi.mock("@/lib/nimiq/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nimiq/client")>();
  return {
    ...actual,
    sendBasicTransactionWithData: vi.fn(),
  };
});

const sendTransactionMock = vi.mocked(sendBasicTransactionWithData);

function readinessResponse(
  fundingReadiness: Record<string, unknown>,
  campaign: Record<string, unknown> = {},
) {
  return {
    kind: "loaded",
    campaign: {
      campaignId: CAMPAIGN,
      title: "Neighborhood cleanup reward",
      status: "draft",
      ...campaign,
    },
    fundingReadiness,
  };
}

const UNFUNDED = {
  ready: false,
  reason: "ready_for_funding",
  settlementStatus: "configured",
  fundedAmountLuna: "0",
  requiredAmountLuna: "580000",
  vaultReady: true,
};

const FUNDED = {
  ready: true,
  reason: "financially_frozen",
  settlementStatus: "funded",
  fundedAmountLuna: "580000",
  requiredAmountLuna: "580000",
  vaultReady: true,
};

function intentResponse(
  overrides: Record<string, unknown> = {},
  kind: string = "created",
) {
  return {
    kind,
    fundingIntent: {
      fundingIntentId: INTENT,
      campaignId: CAMPAIGN,
      reference: "votum:fund:abc",
      memo: "votum:fund:abc",
      vaultAddressHex: "01" + "c".repeat(38),
      vaultAddressNq: VAULT_NQ,
      requiredFundingLuna: "580000",
      requiredFundingNim: "5.8",
      submittedTransactionHash: null,
      confirmationDeadline: "2026-10-01T12:00:00.000Z",
      createdAt: "2026-09-18T00:00:00.000Z",
      ...overrides,
    },
  };
}

function mockUnfunded() {
  mocks.readiness.mockResolvedValue(readinessResponse({ ...UNFUNDED }));
}

beforeEach(() => {
  localStorage.clear();
  mocks.nimiq.isInsideNimiqPay = true;
  mocks.nimiq.walletStatus = "connected";
  mocks.session.isSessionVerified = true;
  mocks.session.isWalletMatched = true;
  mocks.readiness.mockReset();
  mocks.createIntent.mockReset();
  mocks.bind.mockReset();
  mocks.confirm.mockReset();
  sendTransactionMock.mockReset();
});

describe("CampaignFundingPanel — readiness", () => {
  it("fetches readiness on mount and offers funding when action is required", async () => {
    let resolveReadiness!: (value: unknown) => void;
    mocks.readiness.mockReturnValue(
      new Promise((resolve) => {
        resolveReadiness = resolve;
      }),
    );
    render(<CampaignFundingPanel campaignId={CAMPAIGN} />);

    expect(screen.getByText("Loading funding details…")).toBeInTheDocument();
    resolveReadiness(readinessResponse({ ...UNFUNDED }));
    const fund = await screen.findByRole("button", { name: "Fund this giveaway" });
    expect(fund).toBeEnabled();
    expect(mocks.readiness).toHaveBeenCalledWith(CAMPAIGN);
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it("shows the funded state without creating another intent", async () => {
    mocks.readiness.mockResolvedValue(readinessResponse({ ...FUNDED }));
    render(<CampaignFundingPanel campaignId={CAMPAIGN} />);

    expect(await screen.findByText("Giveaway funded")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fund this giveaway" })).toBeNull();
    expect(
      screen.getByText("This giveaway is funded. No further funding action is needed."),
    ).toBeInTheDocument();
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it("waits for the vault instead of offering funding when it is not ready", async () => {
    mocks.readiness.mockResolvedValue(
      readinessResponse({ ...UNFUNDED, reason: "vault_not_ready", vaultReady: false }),
    );
    render(<CampaignFundingPanel campaignId={CAMPAIGN} />);

    expect(
      await screen.findByText("The campaign vault is not ready yet.", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fund this giveaway" })).toBeNull();
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });
});

describe("CampaignFundingPanel — funding flow", () => {
  it("displays the server vault, amount, and reference from the intent", async () => {
    mockUnfunded();
    mocks.createIntent.mockResolvedValue(intentResponse());
    let resolveSend!: (value: { transactionHash: string }) => void;
    sendTransactionMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );
    render(<CampaignFundingPanel campaignId={CAMPAIGN} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fund this giveaway" }));

    expect(await screen.findByText(VAULT_NQ)).toBeInTheDocument();
    expect(screen.getByText("votum:fund:abc")).toBeInTheDocument();

    resolveSend({ transactionHash: HASH });
    mocks.bind.mockResolvedValue({ kind: "bound", binding: {} });
    mocks.confirm.mockResolvedValue({ kind: "confirmed", confirmation: {} });
    mocks.readiness.mockResolvedValue(readinessResponse({ ...FUNDED }));
    expect(await screen.findByText("Giveaway funded")).toBeInTheDocument();
  });

  it("sends the exact server vault, amount, and reference to the wallet", async () => {
    mockUnfunded();
    mocks.createIntent.mockResolvedValue(intentResponse());
    sendTransactionMock.mockResolvedValue({ transactionHash: HASH });
    mocks.bind.mockResolvedValue({ kind: "bound", binding: {} });
    mocks.confirm.mockResolvedValue({ kind: "confirmed", confirmation: {} });
    render(<CampaignFundingPanel campaignId={CAMPAIGN} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fund this giveaway" }));

    await waitFor(() =>
      expect(sendTransactionMock).toHaveBeenCalledWith(mocks.nimiq.provider, {
        recipient: VAULT_NQ,
        value: 580000,
        data: "votum:fund:abc",
      }),
    );
  });

  it("binds the returned hash, then confirms, then reloads readiness", async () => {
    mockUnfunded();
    mocks.createIntent.mockResolvedValue(intentResponse());
    sendTransactionMock.mockResolvedValue({ transactionHash: HASH });
    mocks.bind.mockResolvedValue({ kind: "bound", binding: {} });
    mocks.confirm.mockResolvedValue({ kind: "confirmed", confirmation: {} });
    render(<CampaignFundingPanel campaignId={CAMPAIGN} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fund this giveaway" }));

    await waitFor(() => expect(mocks.bind).toHaveBeenCalledWith(CAMPAIGN, INTENT, HASH));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(CAMPAIGN, INTENT));
    await waitFor(() => expect(mocks.readiness).toHaveBeenCalledTimes(2));
  });

  it("replays a server-submitted hash without a second wallet send", async () => {
    mockUnfunded();
    mocks.createIntent.mockResolvedValue(
      intentResponse({ submittedTransactionHash: HASH }, "replay"),
    );
    mocks.bind.mockResolvedValue({ kind: "bound_replay", binding: {} });
    mocks.confirm.mockResolvedValue({ kind: "replay", confirmation: {} });
    render(<CampaignFundingPanel campaignId={CAMPAIGN} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fund this giveaway" }));

    await waitFor(() => expect(mocks.bind).toHaveBeenCalledWith(CAMPAIGN, INTENT, HASH));
    expect(sendTransactionMock).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(CAMPAIGN, INTENT));
  });

  it("sends at most once across re-render and state transitions", async () => {
    mockUnfunded();
    mocks.createIntent.mockResolvedValue(intentResponse());
    let resolveSend!: (value: { transactionHash: string }) => void;
    sendTransactionMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );
    mocks.bind.mockResolvedValue({ kind: "bound", binding: {} });
    mocks.confirm.mockResolvedValue({ kind: "confirmed", confirmation: {} });
    const { rerender } = render(<CampaignFundingPanel campaignId={CAMPAIGN} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fund this giveaway" }));
    await screen.findByText("Approve the exact funding amount in Nimiq Pay.", { exact: false });
    rerender(<CampaignFundingPanel campaignId={CAMPAIGN} />);
    resolveSend({ transactionHash: HASH });

    await waitFor(() => expect(mocks.bind).toHaveBeenCalledTimes(1));
    expect(sendTransactionMock).toHaveBeenCalledTimes(1);
  });
});

describe("CampaignFundingPanel — failure safety", () => {
  it("treats a denied wallet send as cancelled without recording anything", async () => {
    mockUnfunded();
    mocks.createIntent.mockResolvedValue(intentResponse());
    sendTransactionMock.mockResolvedValue({ denied: true });
    render(<CampaignFundingPanel campaignId={CAMPAIGN} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fund this giveaway" }));

    expect(
      await screen.findByText("Funding cancelled. No transaction was sent."),
    ).toBeInTheDocument();
    expect(mocks.bind).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    // No fabricated readiness: the funding action is still offered.
    expect(screen.getByRole("button", { name: "Continue funding" })).toBeInTheDocument();
  });

  it("keeps a sent hash recoverable when binding fails", async () => {
    mockUnfunded();
    mocks.createIntent.mockResolvedValue(intentResponse());
    sendTransactionMock.mockResolvedValue({ transactionHash: HASH });
    mocks.bind.mockResolvedValue({
      kind: "error",
      error: { code: "service_unavailable", status: 503 },
    });
    render(<CampaignFundingPanel campaignId={CAMPAIGN} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fund this giveaway" }));

    expect(
      await screen.findByText("Transaction sent, but Votum could not record it yet.", {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(sendTransactionMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a missing giveaway without a funding action", async () => {
    mocks.readiness.mockResolvedValue({
      kind: "error",
      error: { code: "campaign_not_found", status: 404 },
    });
    render(<CampaignFundingPanel campaignId={CAMPAIGN} />);
    expect(await screen.findByText("Giveaway not found.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fund this giveaway" })).toBeNull();
  });

  it("surfaces intent failures inline without touching the wallet", async () => {
    mockUnfunded();
    mocks.createIntent.mockResolvedValue({
      kind: "error",
      error: { code: "vault_unavailable", status: 503, message: "The Campaign vault is not available." },
    });
    render(<CampaignFundingPanel campaignId={CAMPAIGN} />);
    fireEvent.click(await screen.findByRole("button", { name: "Fund this giveaway" }));
    expect(
      await screen.findByText("The Campaign vault is not available."),
    ).toBeInTheDocument();
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });
});
