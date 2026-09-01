import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import MyPollDetailPage from "@/app/my-polls/[pollId]/page";

const POLL_ID = "2cb02282-a570-452a-9557-7524567bdd34";

const mocks = vi.hoisted(() => ({
  nimiq: {
    runtimeStatus: "available",
    provider: null,
    isInsideNimiqPay: true,
    walletStatus: "connected",
  },
  session: {
    status: "verified",
    isSessionVerified: true,
    isWalletMatched: true,
    verifyActiveWallet: vi.fn(),
  },
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/layout/ProductShell", () => ({
  ProductShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/WalletButton", () => ({
  WalletButton: () => <button type="button">Connect wallet</button>,
}));

vi.mock("@/providers/NimiqProvider", () => ({
  useNimiqContext: () => mocks.nimiq,
}));

vi.mock("@/providers/VotumSessionProvider", () => ({
  useVotumSession: () => mocks.session,
}));

const configuredConfig = {
  pollQuestion: "VB.2 Reward Funding QA",
  economicModel: "reward_first",
  rewardMode: "rewarded",
  state: "configured",
  rewardPerParticipant: { luna: "1000", nim: 0.01 },
  maxRewardedParticipants: 1,
  rewardPrincipal: { luna: "1000", nim: 0.01 },
  feeReserve: { luna: "8000", nim: 0.08 },
  totalRequiredFunding: { luna: "9000", nim: 0.09 },
  vaultAddressNq: "NQ00 0000 0000 0000 0000 0000 0000 0000 0000",
  funding: null,
};

function mockConfig(status: number, config = configuredConfig) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => (status === 200 ? { config } : {}),
    }),
  );
}

async function renderPage() {
  render(
    await MyPollDetailPage({
      params: Promise.resolve({ pollId: POLL_ID }),
    }),
  );
}

beforeEach(() => {
  mocks.nimiq.runtimeStatus = "available";
  mocks.nimiq.walletStatus = "connected";
  mocks.session.status = "verified";
  mocks.session.isSessionVerified = true;
  mocks.session.isWalletMatched = true;
  mocks.session.verifyActiveWallet.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/my-polls/[pollId] creator management access", () => {
  it("shows verified creator funding controls instead of a connect state", async () => {
    mockConfig(200);
    await renderPage();

    await waitFor(() => expect(screen.getByRole("button", { name: "Fund reward campaign" })).toBeInTheDocument());
    expect(screen.getByText("VB.2 Reward Funding QA")).toBeInTheDocument();
    expect(screen.queryByText("Connect your wallet to manage this poll.")).not.toBeInTheDocument();
  });

  it("shows the connect state only when the wallet is disconnected", async () => {
    mocks.nimiq.walletStatus = "disconnected";
    mockConfig(401);
    await renderPage();

    expect(screen.getByText("Connect your wallet to manage this poll.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeInTheDocument();
  });

  it("shows the verify state for a connected but unverified wallet", async () => {
    mocks.session.status = "unverified";
    mocks.session.isSessionVerified = false;
    mocks.session.isWalletMatched = false;
    mockConfig(401);
    await renderPage();

    expect(screen.getByText("Verify wallet ownership to manage this poll.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify wallet ownership" })).toBeInTheDocument();
    expect(screen.queryByText("Connect your wallet to manage this poll.")).not.toBeInTheDocument();
  });

  it("keeps a non-owner blocked without presenting a connect state", async () => {
    mockConfig(403);
    await renderPage();

    await waitFor(() => expect(screen.getByText(/permission to manage this poll/i)).toBeInTheDocument());
    expect(screen.queryByText("Connect your wallet to manage this poll.")).not.toBeInTheDocument();
  });

  it("surfaces a missing campaign as not found", async () => {
    mockConfig(404);
    await renderPage();

    await waitFor(() => expect(screen.getByText(/reward campaign not found/i)).toBeInTheDocument());
    expect(screen.queryByText("Connect your wallet to manage this poll.")).not.toBeInTheDocument();
  });

  it("does not map a management fetch failure to disconnected wallet copy", async () => {
    mockConfig(500);
    await renderPage();

    await waitFor(() => expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument());
    expect(screen.queryByText("Connect your wallet to manage this poll.")).not.toBeInTheDocument();
  });
});
