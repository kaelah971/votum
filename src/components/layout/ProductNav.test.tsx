import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ProductNav } from "@/components/layout/ProductNav";

const ADDRESS = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
const SPACELESS = ADDRESS.replace(/\s+/g, "");

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
  pathname: "/explore",
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
  usePathname: () => mocks.pathname,
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
  mocks.nimiq.walletStatus = "disconnected";
  mocks.nimiq.activeAccount = null;
  mocks.session.status = "unverified";
  mocks.session.verifiedWalletAddress = null;
  mocks.session.isSessionVerified = false;
  mocks.session.isWalletMatched = false;
  mocks.onboarding.openOnboarding.mockClear();
  mocks.pathname = "/explore";
}

beforeEach(() => {
  resetMocks();
});

function openDrawer() {
  fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
}

// The desktop top bar renders nav links too (hidden on mobile via CSS), so
// drawer-scoped queries must target the drawer overlay container.
function getDrawer() {
  const drawer = document.querySelector(".overflow-y-auto");
  if (!drawer) throw new Error("drawer not found");
  return within(drawer as HTMLElement);
}

describe("ProductNav drawer — nav links intact", () => {
  it("keeps Explore/Create/My Polls/Drafts/Insights links", () => {
    render(<ProductNav />);
    openDrawer();
    const drawer = getDrawer();

    for (const label of [
      "Explore",
      "Create",
      "How it works",
      "My Polls",
      "Drafts",
      "Insights",
    ]) {
      expect(drawer.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("drawer is scrollable for small viewports", () => {
    render(<ProductNav />);
    openDrawer();
    const drawer = screen.getByRole("navigation", { name: "Product navigation" })
      .parentElement!.querySelector(".overflow-y-auto");
    expect(drawer).not.toBeNull();
    expect(drawer?.className).toMatch(/overflow-y-auto/);
  });
});

describe("ProductNav drawer — disconnected", () => {
  it("exposes a Connect wallet account action that opens onboarding", () => {
    render(<ProductNav />);
    openDrawer();
    const drawer = getDrawer();

    const connect = drawer.getAllByRole("button", { name: "Connect wallet" })[0];
    expect(connect).toBeInTheDocument();

    fireEvent.click(connect);
    expect(mocks.onboarding.openOnboarding).toHaveBeenCalledWith({
      intent: "generic_connect",
    });
  });

  it("does not expose owner-only Edit profile as if verified", () => {
    render(<ProductNav />);
    openDrawer();
    const drawer = getDrawer();
    expect(drawer.queryByRole("link", { name: "Edit profile" })).not.toBeInTheDocument();
    expect(drawer.queryByRole("link", { name: "View profile" })).not.toBeInTheDocument();
  });
});

describe("ProductNav drawer — connected but unverified", () => {
  it("exposes a Verify this wallet account action", () => {
    mocks.nimiq.walletStatus = "connected";
    mocks.nimiq.activeAccount = ADDRESS;

    render(<ProductNav />);
    openDrawer();
    const drawer = getDrawer();

    const verify = drawer.getByRole("button", { name: "Verify this wallet" });
    expect(verify).toBeInTheDocument();

    fireEvent.click(verify);
    expect(mocks.onboarding.openOnboarding).toHaveBeenCalledWith({
      intent: "generic_connect",
    });
  });

  it("does not expose owner-only Edit profile as if verified", () => {
    mocks.nimiq.walletStatus = "connected";
    mocks.nimiq.activeAccount = ADDRESS;

    render(<ProductNav />);
    openDrawer();
    const drawer = getDrawer();
    expect(drawer.queryByRole("link", { name: "Edit profile" })).not.toBeInTheDocument();
    expect(drawer.queryByRole("link", { name: "View profile" })).not.toBeInTheDocument();
  });
});

describe("ProductNav drawer — verified", () => {
  it("exposes View profile and Edit profile actions", () => {
    mocks.nimiq.walletStatus = "connected";
    mocks.nimiq.activeAccount = ADDRESS;
    mocks.session.status = "verified";
    mocks.session.verifiedWalletAddress = ADDRESS;
    mocks.session.isSessionVerified = true;
    mocks.session.isWalletMatched = true;

    render(<ProductNav />);
    openDrawer();
    const drawer = getDrawer();

    expect(drawer.getByRole("link", { name: "View profile" })).toBeInTheDocument();
    expect(drawer.getByRole("link", { name: "Edit profile" })).toBeInTheDocument();
  });

  it("View profile uses the route-safe canonical wallet path", () => {
    mocks.nimiq.walletStatus = "connected";
    mocks.nimiq.activeAccount = ADDRESS;
    mocks.session.status = "verified";
    mocks.session.verifiedWalletAddress = ADDRESS;
    mocks.session.isSessionVerified = true;
    mocks.session.isWalletMatched = true;

    render(<ProductNav />);
    openDrawer();
    const drawer = getDrawer();

    const viewProfile = drawer.getByRole("link", { name: "View profile" });
    const href = viewProfile.getAttribute("href") ?? "";
    expect(href).toBe(`/profile/${SPACELESS}`);
    expect(href).not.toMatch(/[\s%]/);
  });
});
