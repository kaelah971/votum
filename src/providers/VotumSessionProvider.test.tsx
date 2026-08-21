import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VotumSessionProvider } from "@/providers/VotumSessionProvider";
import { WalletOnboardingSheet } from "@/components/onboarding/WalletOnboardingSheet";

// Representative SDK cancellation as a REJECTED promise with a plain object
// (what the physical overlay showed as "[object Object]").
const SDK_REJECTION = { error: { type: "denied", message: "Request rejected" } };

const mocks = vi.hoisted(() => {
  let signImpl: () => Promise<unknown> = () => Promise.reject(SDK_REJECTION);
  return {
    nimiq: {
      runtimeStatus: "available",
      walletStatus: "connected",
      accounts: ["NQ34 0000 0000 0000 0000 0000 0000 0000 0000"],
      activeAccount: "NQ34 0000 0000 0000 0000 0000 0000 0000 0000",
      provider: {
        sign: () => signImpl(),
      },
      connectWallet: vi.fn(),
      disconnectWallet: vi.fn(),
      setActiveAccount: vi.fn(),
      retryInit: vi.fn(),
      error: null,
      isInsideNimiqPay: true,
    },
    setSignImpl: (fn: () => Promise<unknown>) => {
      signImpl = fn;
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

vi.mock("@/providers/NimiqProvider", () => ({
  useNimiqContext: () => mocks.nimiq,
}));

vi.mock("@/providers/OnboardingProvider", () => ({
  useOnboarding: () => ({
    open: true,
    state: "connected_unverified",
    intent: null,
    verifiedWalletAddress: null,
    profileReady: false,
    openOnboarding: vi.fn(),
    closeOnboarding: vi.fn(),
  }),
}));

const unhandled: unknown[] = [];
function onUnhandled(e: PromiseRejectionEvent) {
  unhandled.push(e.reason);
}

function Probe() {
  const session = useVotumSessionProbe();
  return <div data-testid="status">{session.status}</div>;
}

import { useVotumSession } from "@/providers/VotumSessionProvider";

function useVotumSessionProbe() {
  return useVotumSession();
}

beforeEach(() => {
  unhandled.length = 0;
  window.addEventListener("unhandledrejection", onUnhandled);
  mocks.setSignImpl(() => Promise.reject(SDK_REJECTION));
});

afterEach(() => {
  window.removeEventListener("unhandledrejection", onUnhandled);
});

describe("verifyActiveWallet — SDK cancellation (rejected plain object)", () => {
  it("catches the rejected sign promise and never leaks an unhandled rejection", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/challenge")) {
        return new Response(
          JSON.stringify({ challengeId: "c1", message: "sign this" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <VotumSessionProvider>
        <Probe />
        <WalletOnboardingSheet />
      </VotumSessionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Verify wallet ownership" }));

    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("permission_denied");
    });

    expect(unhandled).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

describe("verifyActiveWallet — repeated cancellation (retry then reject)", () => {
  it("never leaks an unhandled rejection across cancel→retry→cancel", async () => {
    // Attempt 1: SDK resolves with ErrorResponse denial (the clean first path).
    // Attempt 2: SDK rejects with a plain object (the physical retry path).
    const attempts: Array<() => Promise<unknown>> = [
      () =>
        Promise.resolve({
          error: { type: "denied", message: "Request rejected by user" },
        }),
      () => Promise.reject(SDK_REJECTION),
    ];
    mocks.setSignImpl(() => attempts.shift()!());

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/challenge")) {
        return new Response(
          JSON.stringify({ challengeId: "c2", message: "sign this" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <VotumSessionProvider>
        <Probe />
        <WalletOnboardingSheet />
      </VotumSessionProvider>,
    );

    // First cancel → clean rejected_cancelled
    fireEvent.click(screen.getByRole("button", { name: "Verify wallet ownership" }));
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("permission_denied");
    });
    expect(unhandled).toHaveLength(0);

    // Retry → second cancel (SDK rejects with plain object)
    fireEvent.click(screen.getByRole("button", { name: "Verify wallet ownership" }));
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).not.toBe("requesting_challenge");
    });

    // After the async settle, no unhandled rejection may remain.
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toHaveLength(0);

    vi.unstubAllGlobals();
  });
});
