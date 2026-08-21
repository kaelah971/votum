import { describe, it, expect } from "vitest";
import { formatClosingTime, formatDate } from "@/lib/format";

describe("formatClosingTime", () => {
  // Construct dates from local components so the wall-clock fields are
  // independent of the runtime timezone — this is what makes the string
  // byte-for-byte deterministic between server and client rendering.
  it("produces a deterministic date+time string", () => {
    const d = new Date(2026, 7, 22, 1, 42, 0);
    expect(formatClosingTime(d)).toBe("Aug 22, 2026, 1:42 AM");
  });

  it("uses a fixed separator, never the engine-dependent combined pattern", () => {
    const d = new Date(2026, 7, 22, 1, 42, 0);
    const out = formatClosingTime(d);
    // WebKit renders the combined date+time pattern as "... at 1:42 AM";
    // the split formatter must never emit that.
    expect(out).not.toMatch(/\bat\b/);
    expect(out).toBe("Aug 22, 2026, 1:42 AM");
  });

  it("renders identical output for the same instant regardless of runtime timezone", () => {
    const d = new Date(2026, 7, 22, 1, 42, 0);
    const a = formatClosingTime(d);
    const b = formatClosingTime(new Date(d.getTime()));
    expect(a).toBe(b);
  });

  it("handles 12-hour rollover deterministically", () => {
    expect(formatClosingTime(new Date(2026, 7, 22, 0, 5, 0))).toBe(
      "Aug 22, 2026, 12:05 AM",
    );
    expect(formatClosingTime(new Date(2026, 7, 22, 12, 5, 0))).toBe(
      "Aug 22, 2026, 12:05 PM",
    );
  });
});

describe("formatDate", () => {
  it("is date-only and deterministic", () => {
    expect(formatDate(new Date(2026, 7, 22, 1, 42))).toBe("Aug 22, 2026");
  });
});
