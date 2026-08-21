import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import CreatePollPage from "@/app/create/page";

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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/create",
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

vi.mock("@/lib/drafts/usePollDraft", () => ({
  usePollDraft: () => ({
    draft: null,
    setDraftStatus: vi.fn(),
    saveImmediately: vi.fn(),
  }),
}));

vi.mock("@/lib/drafts/storage", () => ({
  getDraft: vi.fn(() => null),
  ensurePublicationKey: vi.fn(() => "k"),
  deleteDraft: vi.fn(),
}));

function resetMocks() {
  mocks.nimiq.walletStatus = "disconnected";
  mocks.nimiq.activeAccount = null;
  mocks.session.status = "unverified";
  mocks.session.verifiedWalletAddress = null;
  mocks.session.isSessionVerified = false;
  mocks.session.isWalletMatched = false;
}

beforeEach(() => {
  resetMocks();
});

describe("/create — disconnected", () => {
  it("does not expose a usable create form", () => {
    render(<CreatePollPage />);
    expect(screen.getByText("Connect your wallet to create")).toBeInTheDocument();
    expect(screen.queryByText("Build a Votum Poll.")).not.toBeInTheDocument();
    expect(screen.queryByText("Continue to support details")).not.toBeInTheDocument();
  });
});

describe("/create — connected but unverified", () => {
  it("does not expose a usable create form; shows verify-to-create gate", () => {
    mocks.nimiq.walletStatus = "connected";
    mocks.nimiq.activeAccount = ADDRESS;

    render(<CreatePollPage />);
    expect(screen.getByText("Verify wallet ownership to create")).toBeInTheDocument();
    expect(screen.queryByText("Build a Votum Poll.")).not.toBeInTheDocument();
    expect(screen.queryByText("Continue to support details")).not.toBeInTheDocument();
  });
});

describe("/create — verified", () => {
  it("renders the create form for a verified, matched session", () => {
    mocks.nimiq.walletStatus = "connected";
    mocks.nimiq.activeAccount = ADDRESS;
    mocks.session.status = "verified";
    mocks.session.verifiedWalletAddress = ADDRESS;
    mocks.session.isSessionVerified = true;
    mocks.session.isWalletMatched = true;

    render(<CreatePollPage />);
    expect(screen.getByText("Build a Votum Poll.")).toBeInTheDocument();
    expect(screen.queryByText("Verify wallet ownership to create")).not.toBeInTheDocument();
  });
});
