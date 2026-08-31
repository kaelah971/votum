import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { VotumReceiptView } from "@/components/poll/VotumReceiptView";
import type { ReceiptView } from "@/types/poll";

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

const baseReceipt = {
  id: "receipt-1",
  pollId: "poll-1",
  pollQuestion: "Which option should ship next?",
  chosenOption: "Option A",
  recordedAt: "2026-08-31T00:00:00.000Z",
  pollUrl: "/polls/poll-1",
};

describe("VotumReceiptView", () => {
  it("preserves NIM proof fields for legacy support receipts", () => {
    const receipt: ReceiptView = {
      ...baseReceipt,
      economicModel: "legacy_support",
      nimContribution: 5,
      transactionRef: "a".repeat(64),
      explorerUrl: "https://explorer.example/tx/abc",
    };

    render(<VotumReceiptView receipt={receipt} />);

    expect(screen.getAllByText("Your legacy support signal is recorded")).toHaveLength(2);
    expect(screen.getByText("5 NIM support")).toBeInTheDocument();
    expect(screen.getByText(/tx: /)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View transaction" })).toHaveAttribute(
      "href",
      "https://explorer.example/tx/abc",
    );
  });

  it("renders reward-first receipts without NIM or transaction fields", () => {
    const receipt: ReceiptView = {
      ...baseReceipt,
      economicModel: "reward_first",
      rewardMode: "rewarded",
    };

    render(<VotumReceiptView receipt={receipt} />);

    expect(screen.getAllByText("Your verified vote is recorded")).toHaveLength(2);
    expect(screen.queryByText(/NIM support/)).not.toBeInTheDocument();
    expect(screen.queryByText(/tx: /)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View transaction" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to poll" })).toHaveAttribute(
      "href",
      "/polls/poll-1",
    );
  });
});
