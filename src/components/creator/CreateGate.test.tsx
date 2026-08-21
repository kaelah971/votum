import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CreateGate } from "@/components/creator/CreateGate";

const mocks = vi.hoisted(() => ({
  nimiq: {
    runtimeStatus: "available",
    walletStatus: "disconnected",
    accounts: [] as string[],
    activeAccount: null as string | null,
    connectWallet: vi.fn(),
    disconnectWallet: vi.fn(),
    setActiveAccount: vi.fn(),
    retryInit: vi.fn(),
    error: null,
  },
  session: {
    status: "unverified",
    verifiedWalletAddress: null as string | null,
    error: null,
    verifyActiveWallet: vi.fn(),
    endVerifiedSession: vi.fn(),
    refreshSession: vi.fn(),
    isSessionVerified: false,
    isWalletMatched: false,
  },
  onboarding: {
    open: false,
    state: "disconnected",
    intent: null,
    verifiedWalletAddress: null,
    profileReady: false,
    openOnboarding: vi.fn(),
    closeOnboarding: vi.fn(),
  },
}));

vi.mock("@/providers/NimiqProvider", () => ({
  useNimiqContext: () => mocks.nimiq,
}));

vi.mock("@/providers/VotumSessionProvider", () => ({
  useVotumSession: () => mocks.session,
}));

vi.mock("@/providers/OnboardingProvider", () => ({
  useOnboarding: () => mocks.onboarding,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/create",
}));

function resetMocks() {
  mocks.nimiq.walletStatus = "disconnected";
  mocks.nimiq.activeAccount = null;
  mocks.session.status = "unverified";
  mocks.session.verifiedWalletAddress = null;
  mocks.session.isSessionVerified = false;
  mocks.session.isWalletMatched = false;
  mocks.onboarding.openOnboarding.mockClear();
}

beforeEach(() => {
  resetMocks();
});

describe("CreateGate — disconnected", () => {
  it("exposes a Connect wallet action that opens onboarding with create_poll", () => {
    render(<CreateGate />);

    const connect = screen.getByRole("button", { name: "Connect wallet" });
    expect(connect).toBeInTheDocument();

    fireEvent.click(connect);
    expect(mocks.onboarding.openOnboarding).toHaveBeenCalledWith({
      intent: "create_poll",
      returnPath: "/create",
    });
  });

  it("does not expose a usable create form", () => {
    render(<CreateGate />);
    expect(screen.queryByText("Build a Votum Poll.")).not.toBeInTheDocument();
    expect(screen.queryByText("Continue to support details")).not.toBeInTheDocument();
  });
});

describe("CreateGate — connected but unverified", () => {
  it("exposes a Verify-to-create action that opens onboarding with create_poll", () => {
    mocks.nimiq.walletStatus = "connected";
    mocks.nimiq.activeAccount = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";

    render(<CreateGate />);

    const verify = screen.getByRole("button", { name: "Verify wallet ownership" });
    expect(verify).toBeInTheDocument();
    expect(screen.getByText("Verify wallet ownership to create")).toBeInTheDocument();

    fireEvent.click(verify);
    expect(mocks.onboarding.openOnboarding).toHaveBeenCalledWith({
      intent: "create_poll",
      returnPath: "/create",
    });
  });

  it("does not expose a usable create form", () => {
    mocks.nimiq.walletStatus = "connected";
    mocks.nimiq.activeAccount = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";

    render(<CreateGate />);
    expect(screen.queryByText("Build a Votum Poll.")).not.toBeInTheDocument();
    expect(screen.queryByText("Continue to support details")).not.toBeInTheDocument();
  });
});

describe("CreateGate — verified", () => {
  it("renders nothing so the create form is shown", () => {
    mocks.nimiq.walletStatus = "connected";
    mocks.nimiq.activeAccount = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
    mocks.session.status = "verified";
    mocks.session.verifiedWalletAddress = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
    mocks.session.isSessionVerified = true;
    mocks.session.isWalletMatched = true;

    const { container } = render(<CreateGate />);
    expect(container.firstChild).toBeNull();
  });
});
