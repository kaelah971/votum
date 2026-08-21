import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  session: null as { address: string } | null,
}));

vi.mock("@/lib/api/session", () => ({
  getVerifiedWalletSession: () => mocks.session,
}));

vi.mock("@/lib/nimiq/server-crypto", () => ({
  toUserFriendlyAddress: (raw: string) => {
    if (raw === "ec323ef660c913e4a3f0659bfb6b63333255b278") {
      return "NQ47 VGR3 VVK0 R49X 98YG CNDY NST3 6CR5 BCKQ";
    }
    return raw;
  },
}));

import { GET } from "@/app/api/wallet-proof/session/route";

beforeEach(() => {
  mocks.session = null;
});

describe("GET /api/wallet-proof/session", () => {
  it("returns verified:false when no session exists", async () => {
    mocks.session = null;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: false });
  });

  it("returns the wallet in user-friendly NQ form when a session exists", async () => {
    // The stored session row is canonical hex (signerCanonical); the endpoint
    // must return the user-friendly NQ form so the client can compare it
    // against the SDK's activeAccount.
    mocks.session = {
      address: "ec323ef660c913e4a3f0659bfb6b63333255b278",
    };
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.verified).toBe(true);
    expect(data.walletAddress).toBe(
      "NQ47 VGR3 VVK0 R49X 98YG CNDY NST3 6CR5 BCKQ",
    );
  });
});
