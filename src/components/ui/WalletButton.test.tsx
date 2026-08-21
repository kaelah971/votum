import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WalletButton } from "@/components/ui/WalletButton";

const ADDRESS = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";

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

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
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

function resetMocks() {
  mocks.nimiq.runtimeStatus = "available";
  mocks.nimiq.walletStatus = "disconnected";
  mocks.nimiq.accounts = [];
  mocks.nimiq.activeAccount = null;
  mocks.nimiq.error = null;

  mocks.session.status = "unverified";
  mocks.session.verifiedWalletAddress = null;
  mocks.session.error = null;
  mocks.session.isSessionVerified = false;
  mocks.session.isWalletMatched = false;

  mocks.onboarding.state = "disconnected";
  mocks.onboarding.open = false;
  mocks.onboarding.openOnboarding.mockClear();
}

beforeEach(() => {
  resetMocks();
});

describe("WalletButton — unconnected", () => {
  it("exposes a visible, tappable Connect wallet action", () => {
    render(<WalletButton />);

    const connect = screen.getByRole("button", { name: "Connect wallet" });
    expect(connect).toBeInTheDocument();
    expect(connect.className).not.toMatch(/(^|\s)hidden(\s|$)/);

    fireEvent.click(connect);
    expect(mocks.onboarding.openOnboarding).toHaveBeenCalledWith({
      intent: "generic_connect",
    });
  });
});

describe("WalletButton — connected but unverified", () => {
  it("exposes a verify action from the wallet menu", () => {
    mocks.nimiq.walletStatus = "connected";
    mocks.nimiq.accounts = [ADDRESS];
    mocks.nimiq.activeAccount = ADDRESS;

    render(<WalletButton />);

    fireEvent.click(screen.getByRole("button", { name: "Wallet account menu" }));

    const verify = screen.getByRole("button", { name: "Verify this wallet" });
    expect(verify).toBeInTheDocument();

    fireEvent.click(verify);
    expect(mocks.onboarding.openOnboarding).toHaveBeenCalledWith({
      intent: "generic_connect",
    });
  });
});

describe("WalletButton — verified", () => {
  it("shows the verified wallet/profile menu state", () => {
    mocks.nimiq.walletStatus = "connected";
    mocks.nimiq.accounts = [ADDRESS];
    mocks.nimiq.activeAccount = ADDRESS;
    mocks.session.status = "verified";
    mocks.session.verifiedWalletAddress = ADDRESS;
    mocks.session.isSessionVerified = true;
    mocks.session.isWalletMatched = true;

    render(<WalletButton />);

    fireEvent.click(screen.getByRole("button", { name: "Wallet account menu" }));

    expect(screen.getByRole("link", { name: "View profile" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit profile" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My polls" })).toBeInTheDocument();
    expect(screen.getByText("Session verified")).toBeInTheDocument();
  });
});
