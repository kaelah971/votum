import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateGiveawayForm } from "@/components/campaign/CreateGiveawayForm";

const CAMPAIGN = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  createCampaign: vi.fn(),
  push: vi.fn(),
  nimiq: {
    walletStatus: "connected",
  },
  session: {
    status: "verified",
    isSessionVerified: true,
    isWalletMatched: true,
    verifyActiveWallet: vi.fn(),
  },
  onboarding: {
    openOnboarding: vi.fn(),
  },
}));

vi.mock("@/lib/campaigns/creator-client", () => ({
  createCampaign: mocks.createCampaign,
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
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => "/campaigns/new",
}));

function verifiedSession() {
  mocks.session.status = "verified";
  mocks.session.isSessionVerified = true;
  mocks.session.isWalletMatched = true;
  mocks.nimiq.walletStatus = "connected";
}

function unverifiedSession() {
  mocks.session.status = "unverified";
  mocks.session.isSessionVerified = false;
  mocks.session.isWalletMatched = false;
  mocks.nimiq.walletStatus = "disconnected";
}

beforeEach(() => {
  verifiedSession();
  mocks.createCampaign.mockReset();
  mocks.push.mockReset();
  mocks.onboarding.openOnboarding.mockClear();
});

/**
 * The shared Input/Textarea primitives forward onChange through onInput,
 * so tests type with `input` events; Select is a native select element.
 */
function typeInto(label: string, value: string) {
  fireEvent.input(screen.getByLabelText(label), { target: { value } });
}

function fillValidForm() {
  typeInto("Giveaway title", "Neighborhood cleanup reward");
  typeInto("Description", "Rewarding verified cleanup participation.");
  typeInto("Reward per participant", "0.5");
  typeInto("Maximum rewarded participants", "10");
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Create giveaway" }));
}

describe("CreateGiveawayForm — session/creator gate", () => {
  it("gates unverified visitors with the shared create onboarding entry", () => {
    unverifiedSession();
    render(<CreateGiveawayForm />);

    expect(
      screen.getByRole("button", { name: "Connect wallet" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create giveaway" }),
    ).toBeNull();
  });

  it("gates connected-but-unverified wallets with the verify entry", () => {
    mocks.nimiq.walletStatus = "connected";
    mocks.session.status = "unverified";
    mocks.session.isSessionVerified = false;
    mocks.session.isWalletMatched = false;
    render(<CreateGiveawayForm />);

    expect(
      screen.getByRole("button", { name: "Verify wallet ownership" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create giveaway" }),
    ).toBeNull();
  });
});

describe("CreateGiveawayForm — form rendering and validation", () => {
  it("renders the giveaway form for verified creators", () => {
    render(<CreateGiveawayForm />);

    expect(
      screen.getByRole("heading", { name: "Create a Public Giveaway." }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Giveaway title")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
    expect(screen.getByLabelText("Reward per participant")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Maximum rewarded participants"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Starts at")).toBeInTheDocument();
    expect(screen.getByLabelText("Ends at")).toBeInTheDocument();
    expect(screen.getByLabelText("Visibility")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create giveaway" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Next, publish it, then fund the reward budget from the management page.", {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it("requires a title before submitting", async () => {
    render(<CreateGiveawayForm />);
    typeInto("Reward per participant", "0.5");
    typeInto("Maximum rewarded participants", "10");
    submit();

    expect(
      await screen.findByText("Enter a title between 1 and 160 characters."),
    ).toBeInTheDocument();
    expect(mocks.createCampaign).not.toHaveBeenCalled();
  });

  it("rejects non-positive and non-numeric reward amounts", async () => {
    render(<CreateGiveawayForm />);
    typeInto("Giveaway title", "Neighborhood cleanup reward");
    typeInto("Maximum rewarded participants", "10");

    for (const bad of ["", "0", "-1", "abc"]) {
      typeInto("Reward per participant", bad);
      submit();
      expect(
        await screen.findByText("Enter a reward amount greater than 0 NIM."),
      ).toBeInTheDocument();
      expect(mocks.createCampaign).not.toHaveBeenCalled();
    }
  });

  it("rejects non-positive and fractional participant caps", async () => {
    render(<CreateGiveawayForm />);
    typeInto("Giveaway title", "Neighborhood cleanup reward");
    typeInto("Reward per participant", "0.5");

    for (const bad of ["", "0", "-5", "1.5", "abc"]) {
      typeInto("Maximum rewarded participants", bad);
      submit();
      expect(
        await screen.findByText(
          "Enter a whole number of participants (1 or more).",
        ),
      ).toBeInTheDocument();
      expect(mocks.createCampaign).not.toHaveBeenCalled();
    }
  });

  it("rejects an end that is not after the start", async () => {
    render(<CreateGiveawayForm />);
    fillValidForm();
    typeInto("Starts at", "2026-10-02T12:00");
    typeInto("Ends at", "2026-10-01T12:00");
    submit();

    expect(
      await screen.findByText("End must be after the start."),
    ).toBeInTheDocument();
    expect(mocks.createCampaign).not.toHaveBeenCalled();
  });
});

describe("CreateGiveawayForm — submit contract", () => {
  it("sends the exact createCampaign input with no authority fields", async () => {
    mocks.createCampaign.mockResolvedValue({
      kind: "created",
      campaign: { campaignId: CAMPAIGN },
    });
    render(<CreateGiveawayForm />);
    fillValidForm();
    fireEvent.change(screen.getByLabelText("Visibility"), {
      target: { value: "unlisted" },
    });
    submit();

    await waitFor(() =>
      expect(mocks.createCampaign).toHaveBeenCalledTimes(1),
    );
    const input = mocks.createCampaign.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(input).toEqual({
      type: "public_giveaway",
      title: "Neighborhood cleanup reward",
      description: "Rewarding verified cleanup participation.",
      visibility: "unlisted",
      startsAt: null,
      endsAt: null,
      rewardPerParticipant: "0.5",
      maxRewardedParticipants: 10,
      fundingMode: "creator",
    });
    for (const forbidden of [
      "settlementId",
      "vault",
      "vaultAddress",
      "owner",
      "ownerWallet",
      "fundedAmountLuna",
      "funded",
      "financialStatus",
      "status",
      "rewardedParticipantCount",
      "refundRecipientWallet",
      "refund",
      "receipt",
      "feeReserveLuna",
      "totalBudgetLuna",
      "rewardPrincipalLuna",
    ]) {
      expect(input, forbidden).not.toHaveProperty(forbidden);
    }
  });

  it("sends null description and ISO window when provided", async () => {
    mocks.createCampaign.mockResolvedValue({
      kind: "created",
      campaign: { campaignId: CAMPAIGN },
    });
    render(<CreateGiveawayForm />);
    typeInto("Giveaway title", "Timed reward");
    typeInto("Reward per participant", "1");
    typeInto("Maximum rewarded participants", "20");
    typeInto("Starts at", "2026-10-01T12:00");
    typeInto("Ends at", "2026-10-02T12:00");
    submit();

    await waitFor(() =>
      expect(mocks.createCampaign).toHaveBeenCalledTimes(1),
    );
    const input = mocks.createCampaign.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(input.description).toBeNull();
    expect(typeof input.startsAt).toBe("string");
    expect(typeof input.endsAt).toBe("string");
    expect(
      new Date(input.endsAt as string).getTime(),
    ).toBeGreaterThan(new Date(input.startsAt as string).getTime());
  });

  it("shows a loading state while creating", async () => {
    let resolveCreate!: (
      value: { kind: "created"; campaign: unknown } | never,
    ) => void;
    mocks.createCampaign.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve as typeof resolveCreate;
      }),
    );
    render(<CreateGiveawayForm />);
    fillValidForm();
    submit();

    expect(
      await screen.findByRole("button", { name: "Creating..." }),
    ).toBeDisabled();
    resolveCreate({ kind: "created", campaign: { campaignId: CAMPAIGN } });
    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
  });

  it("displays the preserved server error code on failure", async () => {
    mocks.createCampaign.mockResolvedValue({
      kind: "error",
      error: { code: "invalid_request", status: 422 },
    });
    render(<CreateGiveawayForm />);
    fillValidForm();
    submit();

    expect(
      await screen.findByText("Could not create giveaway (invalid_request).", {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("navigates to the manage route on success", async () => {
    mocks.createCampaign.mockResolvedValue({
      kind: "created",
      campaign: { campaignId: CAMPAIGN },
    });
    render(<CreateGiveawayForm />);
    fillValidForm();
    submit();

    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(
        `/campaigns/${CAMPAIGN}/manage`,
      ),
    );
  });
});
