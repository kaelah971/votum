import "server-only";
import { Address, PublicKey, Signature } from "@nimiq/core";
import { createHash } from "node:crypto";

/**
 * Lightweight pre-validation guard that prevents passing obviously
 * invalid strings to Address.fromString(), which can cause WASM panics
 * that escape JavaScript try/catch in @nimiq/core.
 *
 * Accepted patterns:
 *   - NQ prefix (user-friendly, with or without spaces)
 *   - Hex-only strings (canonical hex representation)
 */
function isLikelyNimiqAddress(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length < 3) return false;
  // User-friendly format always starts with "NQ"
  if (trimmed.toUpperCase().startsWith("NQ")) return true;
  // Canonical hex: only hex characters (even length implied by library)
  return /^[0-9a-fA-F]+$/.test(trimmed);
}

/**
 * Parse a Nimiq address from any supported format (user-friendly NQ or hex).
 * Returns the parsed Address object or null if the input is invalid.
 *
 * Uses Address.fromString() because it supports both user-friendly (NQ)
 * and hex representations — the canonical hex stored in wallet_challenges
 * is NOT user-friendly format.
 *
 * A pre-validation guard prevents WASM panics on completely invalid input.
 */
function parseAddress(raw: string): Address | null {
  const trimmed = raw.trim();
  if (!isLikelyNimiqAddress(trimmed)) return null;
  try {
    return Address.fromString(trimmed);
  } catch {
    return null;
  }
}

/**
 * Normalise a Nimiq address to its canonical hex form.
 * Returns the canonical `toHex()` representation or `null` if parsing fails.
 * No raw-string fallback.
 */
export function normalizeAddress(raw: string): string | null {
  const address = parseAddress(raw);
  if (!address) return null;
  try {
    return address.toHex();
  } catch {
    return null;
  }
}

/**
 * Compare two Nimiq addresses for equality using the library's `equals()` method.
 * Both inputs may be in any format (user-friendly NQ or hex).
 * Returns false if either address cannot be parsed.
 */
export function addressesEqual(a: string, b: string): boolean {
  const addrA = parseAddress(a);
  const addrB = parseAddress(b);
  if (!addrA || !addrB) return false;
  try {
    return addrA.equals(addrB);
  } catch {
    return false;
  }
}

/**
 * Convert any Nimiq address (user-friendly NQ or canonical hex) to its
 * user-friendly display form. Returns null for invalid input.
 */
export function toUserFriendlyAddress(raw: string): string | null {
  const address = parseAddress(raw);
  if (!address) return null;
  try {
    return address.toUserFriendlyAddress();
  } catch {
    return null;
  }
}

/**
 * Derive a Nimiq address from a public key hex string.
 * Returns the canonical `toHex()` representation or `null` if parsing fails.
 */
export function deriveAddressFromPublicKey(publicKeyHex: string): string | null {
  try {
    const publicKey = PublicKey.fromHex(publicKeyHex);
    return publicKey.toAddress().toHex();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNATURE VERIFICATION — Nimiq Signed-Message Envelope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Official Nimiq signed-message prefix.
 *
 * Format: \x16Nimiq Signed Message:\n
 * Length: exactly 23 bytes.
 *
 * Confirmed via real Nimiq Pay device test (iPhone).
 */
const NIMIQ_SIGNED_MESSAGE_PREFIX = "\x16Nimiq Signed Message:\n";

/** Asserts the prefix is exactly 23 bytes — fails at module load if wrong. */
(() => {
  const bytes = new TextEncoder().encode(NIMIQ_SIGNED_MESSAGE_PREFIX);
  if (bytes.length !== 23) {
    throw new Error(
      `Nimiq signed-message prefix is ${bytes.length} bytes (expected 23)`,
    );
  }
})();

/**
 * Build the Nimiq signed-message payload and hash it with SHA-256.
 *
 * The official envelope is:
 *   SHA-256(\x16Nimiq Signed Message:\n + messageLength + message)
 *
 * The Ed25519 signature from Nimiq Pay's `sign(message)` is made
 * over this SHA-256 hash, not over the raw UTF-8 message bytes.
 */
function buildSignedMessageHash(message: string): Uint8Array {
  const prefixBytes = new TextEncoder().encode(NIMIQ_SIGNED_MESSAGE_PREFIX);
  const lengthStr = String(message.length);
  const lengthBytes = new TextEncoder().encode(lengthStr);
  const messageBytes = new TextEncoder().encode(message);

  const totalLength = prefixBytes.length + lengthBytes.length + messageBytes.length;
  const payload = new Uint8Array(totalLength);
  payload.set(prefixBytes, 0);
  payload.set(lengthBytes, prefixBytes.length);
  payload.set(messageBytes, prefixBytes.length + lengthBytes.length);

  return new Uint8Array(createHash("sha256").update(payload).digest());
}

/**
 * Production verifier — verifies a Nimiq Pay Mini App `sign()` signature
 * over the official Nimiq signed-message envelope (SHA-256 hash).
 *
 * Convention confirmed via real Nimiq Pay device test.
 */
export function verifyNimiqMiniAppSignature(
  message: string,
  publicKeyHex: string,
  signatureHex: string,
): boolean {
  try {
    const publicKey = PublicKey.fromHex(publicKeyHex);
    const signature = Signature.fromHex(signatureHex);
    const messageHash = buildSignedMessageHash(message);
    return publicKey.verify(signature, messageHash);
  } catch {
    return false;
  }
}
