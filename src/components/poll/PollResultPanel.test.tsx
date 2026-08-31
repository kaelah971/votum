import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PollResultPanel } from "@/components/poll/PollResultPanel";

const results = {
  options: [
    {
      id: "option-a",
      label: "Option A",
      walletCount: 2,
      nimSignalled: 123,
      percentage: 100,
    },
  ],
  totalWallets: 2,
  totalNim: 123,
  isFinal: true,
};

describe("PollResultPanel economic model", () => {
  it("shows legacy NIM support as a separate metric", () => {
    render(<PollResultPanel results={results} economicModel="legacy_support" />);

    expect(screen.getByText("123 NIM")).toBeInTheDocument();
    expect(screen.getByText("123 NIM contributed")).toBeInTheDocument();
  });

  it("suppresses legacy NIM metrics for reward-first results", () => {
    render(<PollResultPanel results={results} economicModel="reward_first" />);

    expect(screen.getByText("2 total wallets")).toBeInTheDocument();
    expect(screen.queryByText("123 NIM")).not.toBeInTheDocument();
    expect(screen.queryByText("123 NIM contributed")).not.toBeInTheDocument();
  });
});
