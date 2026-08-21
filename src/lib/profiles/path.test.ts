import { describe, it, expect } from "vitest";
import { profileWalletPath } from "@/lib/profiles/path";

describe("profileWalletPath", () => {
  it("strips spaces from a human-readable NQ address", () => {
    expect(profileWalletPath("NQ47 VGR3 VVK0 R49X 98YG CNDY NST3 6CR5 BCKQ")).toBe(
      "NQ47VGR3VVK0R49X98YGCNDYNST36CR5BCKQ",
    );
  });

  it("leaves an already space-free NQ address unchanged", () => {
    const spaceless = "NQ47VGR3VVK0R49X98YGCNDYNST36CR5BCKQ";
    expect(profileWalletPath(spaceless)).toBe(spaceless);
  });

  it("leaves canonical hex unchanged", () => {
    const hex = "ec323ef660c913e4a3f0659bfb6b63333255b278";
    expect(profileWalletPath(hex)).toBe(hex);
  });

  it("never produces URL-unsafe characters", () => {
    const path = profileWalletPath("NQ47 VGR3 VVK0 R49X 98YG CNDY NST3 6CR5 BCKQ");
    expect(path).not.toMatch(/[\s%]/);
  });
});
