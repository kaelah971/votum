import "server-only";
import { KeyPair, PrivateKey } from "@nimiq/core";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Votum campaign-vault key custody (Slice-0 spike).
 *
 * Server-only by construction (`import "server-only"`), exactly like
 * `src/lib/nimiq/server-crypto.ts`. It can never be imported from a Client
 * Component. All private material exists only transiently in this module's
 * scope and is encrypted at rest under the server-only master key.
 *
 * No key material is ever logged, returned in API shapes, or persisted
 * anywhere in this slice.
 */

// ---------------------------------------------------------------------------
// Envelope contract
// ---------------------------------------------------------------------------

export const VAULT_ENVELOPE_VERSION = "votum:reward-vault:v1";
export const VAULT_ENVELOPE_PURPOSE = "votum:reward-vault:v1";
export const MASTER_KEY_BYTES = 32;
export const ENVELOPE_IV_BYTES = 12;

export interface RewardVaultEnvelope {
  version: typeof VAULT_ENVELOPE_VERSION;
  algorithm: "aes-256-gcm";
  iv: string; // base64
  ciphertext: string; // base64
  authTag: string; // base64
}

export interface VaultAadContext {
  campaignId: string;
  vaultAddressHex: string;
}

// ---------------------------------------------------------------------------
// Master key contract (REWARD_VAULT_MASTER_KEY)
// ---------------------------------------------------------------------------

const ENV_VAR = "REWARD_VAULT_MASTER_KEY";

/**
 * Parse and validate the server-only master key.
 *
 * Contract: 32 random bytes encoded as base64 (recommended unless the repo
 * convention says otherwise). Rejects missing, empty, malformed base64,
 * wrong decoded length, and accidentally human-readable weak strings.
 */
export function parseVaultMasterKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === "") {
    throw new Error(
      `vault master key missing: ${ENV_VAR} must be set to 32 random bytes (base64)`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length < 16) {
    throw new Error("vault master key too short (must be 32 random bytes, base64)");
  }
  // Reject obviously human-readable weak strings (no valid base64 chars is a
  // strong hint; a plain ASCII sentence will usually fail base64 decoding).
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new Error("vault master key must be base64");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, "base64");
  } catch {
    throw new Error("vault master key is not valid base64");
  }
  // Buffer.from never throws on bad base64 (it is lossy), so re-encode and
  // compare to catch malformed input.
  if (decoded.toString("base64").replace(/=+$/, "") !== trimmed.replace(/=+$/, "")) {
    throw new Error("vault master key is malformed base64");
  }
  if (decoded.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `vault master key must decode to exactly ${MASTER_KEY_BYTES} bytes (got ${decoded.length})`,
    );
  }
  return decoded;
}

/** Read the master key from the process environment (server-only). */
export function getVaultMasterKey(): Buffer {
  return parseVaultMasterKey(process.env[ENV_VAR]);
}

// ---------------------------------------------------------------------------
// Key generation / address derivation
// ---------------------------------------------------------------------------

export interface GeneratedVaultKey {
  keypair: KeyPair;
  /** Canonical hex (the form Votum stores in wallet columns). */
  addressHex: string;
  /** User-friendly NQ display form. */
  addressNq: string;
  /** 32-byte private key material (transient). */
  privateKeyBytes: Uint8Array;
}

/** Generate a fresh campaign vault keypair (never persisted in this slice). */
export function generateVaultKey(): GeneratedVaultKey {
  const keypair = KeyPair.generate();
  return materializeVaultKey(keypair);
}

function materializeVaultKey(keypair: KeyPair): GeneratedVaultKey {
  const address = keypair.toAddress();
  return {
    keypair,
    addressHex: address.toHex(),
    addressNq: address.toUserFriendlyAddress(),
    privateKeyBytes: keypair.privateKey.serialize(),
  };
}

/** Reconstruct a keypair from 32-byte private material. */
export function reconstructVaultKey(privateKeyBytes: Uint8Array): KeyPair {
  const privateKey = PrivateKey.deserialize(privateKeyBytes);
  return KeyPair.derive(privateKey);
}

/** Reconstruct a keypair and immediately derive its public address. */
export function deriveVaultAddress(privateKeyBytes: Uint8Array): {
  addressHex: string;
  addressNq: string;
} {
  const keypair = reconstructVaultKey(privateKeyBytes);
  try {
    const address = keypair.toAddress();
    return {
      addressHex: address.toHex(),
      addressNq: address.toUserFriendlyAddress(),
    };
  } finally {
    keypair.free?.();
  }
}

// ---------------------------------------------------------------------------
// AES-256-GCM envelope
// ---------------------------------------------------------------------------

/**
 * Build the authenticated additional data (AAD).
 *
 * Binds the ciphertext to its campaign so a vault blob copied from campaign A
 * into campaign B fails authenticated decryption. AAD is deterministic and
 * derived only from immutable context: purpose, campaign id, vault address.
 */
export function buildVaultAad(context: VaultAadContext): Buffer {
  return Buffer.from(
    `${VAULT_ENVELOPE_PURPOSE}\u0000${context.campaignId}\u0000${context.vaultAddressHex}`,
    "utf8",
  );
}

/**
 * Encrypt transient private material into a versioned AES-256-GCM envelope.
 * A random 12-byte IV is generated per encryption.
 */
export function encryptVaultKey(
  privateKeyBytes: Uint8Array,
  masterKey: Buffer,
  context: VaultAadContext,
): RewardVaultEnvelope {
  const iv = randomBytes(ENVELOPE_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(buildVaultAad(context));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKeyBytes)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: VAULT_ENVELOPE_VERSION,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/**
 * Authenticated decryption. Fails closed on any tamper, wrong key, wrong AAD,
 * unknown version, or malformed/truncated envelope. Never returns corrupt
 * plaintext.
 */
export function decryptVaultKey(
  envelope: RewardVaultEnvelope,
  masterKey: Buffer,
  context: VaultAadContext,
): Uint8Array {
  if (envelope.version !== VAULT_ENVELOPE_VERSION) {
    throw new Error(`unknown vault envelope version: ${envelope.version}`);
  }
  if (envelope.algorithm !== "aes-256-gcm") {
    throw new Error(`unsupported vault envelope algorithm: ${envelope.algorithm}`);
  }
  let iv: Buffer;
  let ciphertext: Buffer;
  let authTag: Buffer;
  try {
    iv = Buffer.from(envelope.iv, "base64");
    ciphertext = Buffer.from(envelope.ciphertext, "base64");
    authTag = Buffer.from(envelope.authTag, "base64");
  } catch {
    throw new Error("vault envelope contains malformed base64 fields");
  }
  if (iv.length !== ENVELOPE_IV_BYTES) {
    throw new Error("vault envelope IV length invalid");
  }
  if (authTag.length !== 16) {
    throw new Error("vault envelope auth tag length invalid");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
    decipher.setAAD(buildVaultAad(context));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return new Uint8Array(plaintext);
  } catch {
    // GCM authentication failure — tampered ciphertext, wrong key, or wrong AAD.
    throw new Error("vault envelope authentication failed");
  }
}

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

/** Zero transient key buffers. Best-effort: WASM keypairs also `.free()`. */
export function disposeVaultKey(key: GeneratedVaultKey): void {
  try {
    key.keypair.free?.();
  } catch {
    /* already freed */
  }
  key.privateKeyBytes.fill(0);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return (
    a.length === b.length &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
