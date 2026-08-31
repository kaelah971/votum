import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  router: {
    push: vi.fn(),
    replace: vi.fn(),
  },
  searchParams: new URLSearchParams(),
  draftRecord: null as unknown,
  pollDraft: null as unknown,
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
  useRouter: () => mocks.router,
  useSearchParams: () => mocks.searchParams,
  usePathname: () => "/create",
}));

vi.mock("@/components/decision/PollReview", () => ({
  PollReview: ({ onPublish }: { onPublish: () => void }) => (
    <button type="button" onClick={onPublish}>
      Publish test poll
    </button>
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

vi.mock("@/lib/drafts/usePollDraft", () => ({
  usePollDraft: () => ({
    draft: mocks.pollDraft,
    setDraftStatus: vi.fn(),
    saveImmediately: vi.fn(),
  }),
}));

vi.mock("@/lib/drafts/storage", () => ({
  getDraft: vi.fn(() => mocks.draftRecord),
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
  mocks.router.push.mockClear();
  mocks.router.replace.mockClear();
  mocks.searchParams = new URLSearchParams();
  mocks.draftRecord = null;
  mocks.pollDraft = null;
}

beforeEach(() => {
  resetMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
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

const rewardDraft = {
  id: "draft-rewarded",
  question: "Which reward should this poll offer?",
  context: "",
  options: ["Option A", "Option B"],
  duration: "1day",
  category: "communities",
  format: "decision",
  status: "ready_to_publish",
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
  currentStep: "review",
  economicModel: "reward_first",
  rewardMode: "rewarded",
  rewardFundingMode: "creator",
  rewardPerParticipant: "0.01",
  maxRewardedParticipants: "1",
};

async function renderReadyDraft(response: unknown, rewardMode: "free" | "rewarded" = "rewarded") {
  mocks.nimiq.walletStatus = "connected";
  mocks.nimiq.activeAccount = ADDRESS;
  mocks.session.status = "verified";
  mocks.session.verifiedWalletAddress = ADDRESS;
  mocks.session.isSessionVerified = true;
  mocks.session.isWalletMatched = true;
  mocks.draftRecord = { ...rewardDraft, rewardMode };
  mocks.pollDraft = { id: rewardDraft.id };
  mocks.searchParams = new URLSearchParams(`draft=${rewardDraft.id}`);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => response,
    }),
  );

  render(<CreatePollPage />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Publish test poll" })).toBeInTheDocument());
  screen.getByRole("button", { name: "Publish test poll" }).click();
}

describe("/create — post-publish funding entry", () => {
  it("redirects a newly published rewarded poll to creator funding", async () => {
    await renderReadyDraft(
      {
        poll: { id: "poll-rewarded" },
        reward: { rewardFundingRequired: true },
      },
    );

    await waitFor(() => {
      expect(mocks.router.replace).toHaveBeenCalledWith("/my-polls/poll-rewarded");
    }, { timeout: 2000 });
  });

  it("keeps a free verified poll on the normal public poll route", async () => {
    await renderReadyDraft(
      {
        poll: { id: "poll-free" },
      },
      "free",
    );

    await waitFor(() => {
      expect(mocks.router.replace).toHaveBeenCalledWith("/polls/poll-free?published=1");
    }, { timeout: 2000 });
  });
});
