import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PollHeader } from "@/components/poll/PollHeader";

describe("PollHeader", () => {
  it("renders deterministic closing text for a live poll", () => {
    render(
      <PollHeader
        question="Should we ship? "
        status="live"
        closingAt={new Date(2026, 7, 22, 1, 42, 0).toISOString()}
      />,
    );
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Closes Aug 22, 2026, 1:42 AM")).toBeInTheDocument();
  });

  it("does not render closing text for a closed poll", () => {
    render(
      <PollHeader
        question="Closed question"
        status="closed"
        closingAt={new Date(2026, 7, 22, 1, 42, 0).toISOString()}
      />,
    );
    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.queryByText(/Closes/)).not.toBeInTheDocument();
  });

  it("renders the same closing text on repeated renders (SSR/client determinism)", () => {
    const closingAt = new Date(2026, 7, 22, 1, 42, 0).toISOString();
    const { rerender } = render(
      <PollHeader question="Q" status="live" closingAt={closingAt} />,
    );
    const first = screen.getByText(/Closes/).textContent;
    rerender(<PollHeader question="Q" status="live" closingAt={closingAt} />);
    const second = screen.getByText(/Closes/).textContent;
    expect(first).toBe(second);
    expect(second).toBe("Closes Aug 22, 2026, 1:42 AM");
  });
});
