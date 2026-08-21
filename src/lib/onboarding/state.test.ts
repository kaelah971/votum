import { describe, it, expect } from "vitest";
import { resolveIntentPath } from "@/lib/onboarding/state";

describe("resolveIntentPath", () => {
  it("builds a route-safe profile path from a spaced NQ wallet", () => {
    const path = resolveIntentPath(
      "profile",
      "NQ47 VGR3 VVK0 R49X 98YG CNDY NST3 6CR5 BCKQ",
    );
    expect(path).toBe("/profile/NQ47VGR3VVK0R49X98YGCNDYNST36CR5BCKQ");
  });

  it("returns null for non-profile intents", () => {
    expect(resolveIntentPath("generic_connect", "NQ47 VGR3")).toBeNull();
    expect(resolveIntentPath("vote", "NQ47 VGR3")).toBeNull();
    expect(resolveIntentPath("create_poll", "NQ47 VGR3")).toBeNull();
  });
});
