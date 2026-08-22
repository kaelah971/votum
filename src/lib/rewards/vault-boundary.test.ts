import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { statSync, readdirSync } from "node:fs";
import { generateVaultKey, disposeVaultKey } from "@/lib/rewards/vault-key";
import { buildRewardPayoutTransaction, buildAndSignRewardPayout } from "@/lib/rewards/vault-signing";
import { KeyPair } from "@nimiq/core";

const PROJECT_ROOT = resolve(__dirname, "..", "..", "..");

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(full);
  }
}

describe("server/client boundary", () => {
  it("vault modules declare server-only (Next build-time boundary)", () => {
    for (const f of ["vault-key.ts", "vault-signing.ts"]) {
      const src = readFileSync(resolve(PROJECT_ROOT, "src/lib/rewards", f), "utf8");
      expect(src.includes('import "server-only"')).toBe(true);
    }
  });

  it("no vault module contains 'use client'", () => {
    for (const f of ["vault-key.ts", "vault-signing.ts"]) {
      const src = readFileSync(resolve(PROJECT_ROOT, "src/lib/rewards", f), "utf8");
      expect(src.includes('"use client"')).toBe(false);
      expect(src.includes("'use client'")).toBe(false);
    }
  });

  it("no NEXT_PUBLIC_ master-key reference exists anywhere in vault code", () => {
    for (const f of ["vault-key.ts", "vault-signing.ts"]) {
      const src = readFileSync(resolve(PROJECT_ROOT, "src/lib/rewards", f), "utf8");
      expect(src.includes("NEXT_PUBLIC_")).toBe(false);
    }
  });

  it("no current Client Component imports the vault modules", () => {
    const files: string[] = [];
    for (const d of ["src/components", "src/app", "src/providers", "src/hooks"]) {
      walk(resolve(PROJECT_ROOT, d), files);
    }
    const offending = files.filter((file) => {
      const src = readFileSync(file, "utf8");
      return (
        (src.includes('"use client"') || src.includes("'use client'")) &&
        (src.includes("vault-key") || src.includes("vault-signing"))
      );
    });
    expect(offending).toEqual([]);
  });
});

describe("zero-leak logging / secret surface", () => {
  it("envelope and error surfaces never include private key material", () => {
    const vault = generateVaultKey();
    try {
      const participant = KeyPair.generate();
      const params = {
        senderAddressHex: vault.addressHex,
        recipientAddressHex: participant.toAddress().toHex(),
        rewardPerParticipantLuna: BigInt(50000),
        feeLuna: BigInt(4000),
        validityStartHeight: 1,
        networkId: 42,
      };
      const built = buildRewardPayoutTransaction(params);
      const signed = buildAndSignRewardPayout(vault.privateKeyBytes, params);
      const secretMarker = Buffer.from(vault.privateKeyBytes).toString("hex");

      const outward = [
        JSON.stringify({
          senderHex: signed.senderHex,
          recipientHex: signed.recipientHex,
          valueLuna: signed.valueLuna.toString(),
          feeLuna: signed.feeLuna.toString(),
          hash: signed.hash(),
        }),
        JSON.stringify({
          senderHex: built.senderHex,
          recipientHex: built.recipientHex,
        }),
      ];
      for (const s of outward) {
        expect(s).not.toContain(secretMarker);
      }

      // Error messages identify the failure class, not secret material.
      try {
        buildAndSignRewardPayout(vault.privateKeyBytes, {
          ...params,
          senderAddressHex: participant.toAddress().toHex(), // wrong sender
        });
        expect(true).toBe(false); // should have thrown
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).toContain("does not match");
        expect(msg).not.toContain(secretMarker);
      }
    } finally {
      disposeVaultKey(vault);
    }
  });
});
