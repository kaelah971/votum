import { describe, it, expect } from "vitest";
import {
  VAULT_ENVELOPE_VERSION,
  MASTER_KEY_BYTES,
  ENVELOPE_IV_BYTES,
  generateVaultKey,
  deriveVaultAddress,
  reconstructVaultKey,
  parseVaultMasterKey,
  encryptVaultKey,
  decryptVaultKey,
  buildVaultAad,
  bytesEqual,
  disposeVaultKey,
  type VaultAadContext,
} from "@/lib/rewards/vault-key";
import { randomBytes } from "node:crypto";

function ephemeralMasterKey(): Buffer {
  return randomBytes(MASTER_KEY_BYTES);
}

function ephemeralContext(overrides: Partial<VaultAadContext> = {}): VaultAadContext {
  return {
    campaignId: overrides.campaignId ?? "11111111-1111-4111-8111-111111111111",
    vaultAddressHex: overrides.vaultAddressHex ?? "ab".repeat(20),
  };
}

describe("master key contract", () => {
  it("accepts 32 random bytes in base64", () => {
    const key = ephemeralMasterKey();
    expect(parseVaultMasterKey(key.toString("base64")).length).toBe(MASTER_KEY_BYTES);
  });

  it("rejects missing / empty input", () => {
    expect(() => parseVaultMasterKey(undefined)).toThrow();
    expect(() => parseVaultMasterKey("")).toThrow();
    expect(() => parseVaultMasterKey("   ")).toThrow();
  });

  it("rejects malformed base64", () => {
    expect(() => parseVaultMasterKey("!!!not-base64!!!")).toThrow();
  });

  it("rejects wrong decoded length", () => {
    const short = randomBytes(16).toString("base64");
    const long = randomBytes(48).toString("base64");
    expect(() => parseVaultMasterKey(short)).toThrow(/exactly 32/);
    expect(() => parseVaultMasterKey(long)).toThrow(/exactly 32/);
  });

  it("rejects accidentally human-readable weak strings", () => {
    expect(() => parseVaultMasterKey("correct horse battery staple")).toThrow();
  });
});

describe("key generation and address derivation", () => {
  it("generates a keypair and derives canonical hex + NQ address", () => {
    const vault = generateVaultKey();
    try {
      expect(vault.addressHex).toMatch(/^[0-9a-f]{40}$/);
      expect(vault.addressNq).toMatch(/^NQ[0-9A-Z ]+$/);
      expect(vault.privateKeyBytes.length).toBe(32);
    } finally {
      disposeVaultKey(vault);
    }
  });

  it("two independently generated campaigns differ in address and key", () => {
    const a = generateVaultKey();
    const b = generateVaultKey();
    try {
      expect(a.addressHex).not.toBe(b.addressHex);
      expect(bytesEqual(a.privateKeyBytes, b.privateKeyBytes)).toBe(false);
    } finally {
      disposeVaultKey(a);
      disposeVaultKey(b);
    }
  });
});

describe("offline key round-trip", () => {
  it("serialize → encrypt → discard → decrypt → reconstruct → same address", () => {
    const masterKey = ephemeralMasterKey();
    const vault = generateVaultKey();
    const addressA = vault.addressHex;
    const context = ephemeralContext({ vaultAddressHex: addressA });

    const envelope = encryptVaultKey(vault.privateKeyBytes, masterKey, context);
    disposeVaultKey(vault); // discard the original signing object

    const decrypted = decryptVaultKey(envelope, masterKey, context);
    const addressB = deriveVaultAddress(decrypted).addressHex;
    expect(addressB).toBe(addressA);

    // Reconstruct an actual signing keypair and confirm address equality.
    const rebuilt = reconstructVaultKey(decrypted);
    try {
      expect(rebuilt.toAddress().toHex()).toBe(addressA);
    } finally {
      rebuilt.free?.();
    }
  });

  it("produces different ciphertext for the same key across encryptions (fresh IV)", () => {
    const masterKey = ephemeralMasterKey();
    const vault = generateVaultKey();
    const context = ephemeralContext({ vaultAddressHex: vault.addressHex });
    try {
      const e1 = encryptVaultKey(vault.privateKeyBytes, masterKey, context);
      const e2 = encryptVaultKey(vault.privateKeyBytes, masterKey, context);
      expect(e1.iv).not.toBe(e2.iv);
      expect(e1.ciphertext).not.toBe(e2.ciphertext);
    } finally {
      disposeVaultKey(vault);
    }
  });
});

describe("AAD campaign binding", () => {
  it("ciphertext copied from campaign A into campaign B fails decryption", () => {
    const masterKey = ephemeralMasterKey();
    const vault = generateVaultKey();
    try {
      const ctxA = ephemeralContext({
        campaignId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        vaultAddressHex: vault.addressHex,
      });
      const ctxB = ephemeralContext({
        campaignId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        vaultAddressHex: vault.addressHex,
      });
      const envelope = encryptVaultKey(vault.privateKeyBytes, masterKey, ctxA);
      expect(() => decryptVaultKey(envelope, masterKey, ctxB)).toThrow(
        /authentication failed/,
      );
    } finally {
      disposeVaultKey(vault);
    }
  });

  it("wrong vault address in AAD fails decryption", () => {
    const masterKey = ephemeralMasterKey();
    const vault = generateVaultKey();
    try {
      const ctxA = ephemeralContext({ vaultAddressHex: vault.addressHex });
      const ctxWrong = ephemeralContext({ vaultAddressHex: "cd".repeat(20) });
      const envelope = encryptVaultKey(vault.privateKeyBytes, masterKey, ctxA);
      expect(() => decryptVaultKey(envelope, masterKey, ctxWrong)).toThrow(
        /authentication failed/,
      );
    } finally {
      disposeVaultKey(vault);
    }
  });
});

describe("crypto failure / tamper tests", () => {
  function baseEnvelope() {
    const masterKey = ephemeralMasterKey();
    const vault = generateVaultKey();
    const context = ephemeralContext({ vaultAddressHex: vault.addressHex });
    const envelope = encryptVaultKey(vault.privateKeyBytes, masterKey, context);
    disposeVaultKey(vault);
    return { masterKey, context, envelope };
  }

  /** Flip one byte inside a base64 field, preserving length (real tamper). */
  function flipFieldBase64(value: string, index: number): string {
    const bytes = Buffer.from(value, "base64");
    bytes[index % bytes.length] = (bytes[index % bytes.length] ^ 0xff) >>> 0;
    return bytes.toString("base64");
  }

  it("correct master key decrypts", () => {
    const { masterKey, context, envelope } = baseEnvelope();
    const out = decryptVaultKey(envelope, masterKey, context);
    expect(out.length).toBe(32);
  });

  it("wrong master key fails", () => {
    const { context, envelope } = baseEnvelope();
    const wrong = ephemeralMasterKey();
    expect(() => decryptVaultKey(envelope, wrong, context)).toThrow(
      /authentication failed/,
    );
  });

  it("modified ciphertext fails", () => {
    const { masterKey, context, envelope } = baseEnvelope();
    const tampered = {
      ...envelope,
      ciphertext: flipFieldBase64(envelope.ciphertext, 0),
    };
    expect(() => decryptVaultKey(tampered, masterKey, context)).toThrow(
      /authentication failed/,
    );
  });

  it("modified authentication tag fails", () => {
    const { masterKey, context, envelope } = baseEnvelope();
    const tampered = { ...envelope, authTag: flipFieldBase64(envelope.authTag, 0) };
    expect(() => decryptVaultKey(tampered, masterKey, context)).toThrow(
      /authentication failed/,
    );
  });

  it("modified IV fails (auth failure)", () => {
    const { masterKey, context, envelope } = baseEnvelope();
    const tampered = { ...envelope, iv: flipFieldBase64(envelope.iv, 0) };
    expect(() => decryptVaultKey(tampered, masterKey, context)).toThrow();
  });

  it("unknown envelope version fails closed", () => {
    const { masterKey, context, envelope } = baseEnvelope();
    const bad = { ...envelope, version: "v999" as typeof VAULT_ENVELOPE_VERSION };
    expect(() => decryptVaultKey(bad, masterKey, context)).toThrow(/unknown vault envelope version/);
  });

  it("malformed envelope (missing field) fails", () => {
    const { masterKey, context, envelope } = baseEnvelope();
    const missing = {
      version: envelope.version,
      algorithm: envelope.algorithm,
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
    };
    expect(() =>
      decryptVaultKey(missing as unknown as typeof envelope, masterKey, context),
    ).toThrow();
  });

  it("truncated envelope (short ciphertext) fails", () => {
    const { masterKey, context, envelope } = baseEnvelope();
    const truncated = { ...envelope, ciphertext: envelope.ciphertext.slice(0, 4) };
    expect(() => decryptVaultKey(truncated, masterKey, context)).toThrow();
  });

  it("never returns corrupt plaintext on any failure", () => {
    const { masterKey, context, envelope } = baseEnvelope();
    const attempts = [
      () => decryptVaultKey(envelope, ephemeralMasterKey(), context),
      () => decryptVaultKey(
        { ...envelope, ciphertext: flipFieldBase64(envelope.ciphertext, 0) },
        masterKey,
        context,
      ),
      () => decryptVaultKey(
        { ...envelope, authTag: flipFieldBase64(envelope.authTag, 0) },
        masterKey,
        context,
      ),
      () => decryptVaultKey(
        { ...envelope, version: "x" as typeof VAULT_ENVELOPE_VERSION },
        masterKey,
        context,
      ),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow();
    }
  });
});

describe("envelope format", () => {
  it("exposes only versioned binary fields — never secrets", () => {
    const masterKey = ephemeralMasterKey();
    const vault = generateVaultKey();
    const context = ephemeralContext({ vaultAddressHex: vault.addressHex });
    try {
      const envelope = encryptVaultKey(vault.privateKeyBytes, masterKey, context);
      expect(Object.keys(envelope).sort()).toEqual([
        "algorithm",
        "authTag",
        "ciphertext",
        "iv",
        "version",
      ]);
      expect(envelope.version).toBe(VAULT_ENVELOPE_VERSION);
      expect(envelope.algorithm).toBe("aes-256-gcm");
      expect(Buffer.from(envelope.iv, "base64").length).toBe(ENVELOPE_IV_BYTES);
      // no plaintext / master key / seed fields anywhere
      expect(JSON.stringify(envelope)).not.toContain("key");
      expect(JSON.stringify(envelope)).not.toContain("master");
    } finally {
      disposeVaultKey(vault);
    }
  });

  it("AAD is deterministic for identical context", () => {
    const a = buildVaultAad(ephemeralContext({ vaultAddressHex: "ab".repeat(20) }));
    const b = buildVaultAad(ephemeralContext({ vaultAddressHex: "ab".repeat(20) }));
    expect(Buffer.compare(a, b)).toBe(0);
  });
});
