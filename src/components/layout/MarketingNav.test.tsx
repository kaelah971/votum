import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MarketingNav } from "@/components/layout/MarketingNav";

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

beforeEach(() => {
  mocks.nimiq.walletStatus = "disconnected";
  mocks.nimiq.activeAccount = null;
  mocks.session.isSessionVerified = false;
  mocks.onboarding.openOnboarding.mockClear();
});

describe("MarketingNav — landing header", () => {
  it("includes the WalletButton on the landing page", () => {
    render(<MarketingNav />);

    const connect = screen.getByRole("button", { name: "Connect wallet" });
    expect(connect).toBeInTheDocument();
  });

  it("exposes a visible connect action in the unconnected state", () => {
    render(<MarketingNav />);

    const connect = screen.getByRole("button", { name: "Connect wallet" });
    expect(connect).toBeInTheDocument();
    expect(connect).toHaveAttribute("aria-label", "Connect wallet");

    fireEvent.click(connect);
    expect(mocks.onboarding.openOnboarding).toHaveBeenCalledWith({
      intent: "generic_connect",
    });
  });

  it("does not hide the wallet control behind mobile breakpoint CSS", () => {
    render(<MarketingNav />);

    const connect = screen.getByRole("button", { name: "Connect wallet" });

    // Walk ancestors up to the nav: none may apply a `hidden` utility that
    // would remove the control on mobile.
    let el: HTMLElement | null = connect.parentElement;
    while (el && el !== document.body) {
      expect(el.className).not.toMatch(/(^|\s)hidden(\s|$)/);
      el = el.parentElement;
    }
    expect(connect.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it("keeps +127 as a static NIM-signalled stat pill, not a wallet control", () => {
    render(<MarketingNav />);

    const pill = screen.getByText("+127");
    expect(pill).toBeInTheDocument();
    expect(screen.getByText("NIM signalled")).toBeInTheDocument();

    // The stat pill is a span, not an interactive wallet control.
    expect(pill.tagName).toBe("SPAN");
    expect(pill.closest("button")).toBeNull();

    // And the actual wallet control is separate from the stat.
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+127" })).not.toBeInTheDocument();
  });

  it("places the wallet control at the right edge so its menu stays inside the viewport", () => {
    render(<MarketingNav />);

    const nav = screen.getByRole("navigation", { name: "Marketing navigation" });
    const wallet = screen.getByRole("button", { name: "Connect wallet" });

    // The wallet control must be the last (rightmost) element in the header
    // cluster, so the right-anchored dropdown extends toward the viewport
    // center rather than beyond the left edge on narrow screens.
    const rightCluster = nav.querySelector(
      "div.justify-self-end",
    );
    expect(rightCluster).not.toBeNull();
    const last = rightCluster?.lastElementChild;
    expect(last).not.toBeNull();
    // Either the bare button (disconnected) or its relative wrapper
    // (connected) is the final child.
    expect(
      last === wallet ||
        (last?.contains(wallet) ?? false),
    ).toBe(true);
  });
});
