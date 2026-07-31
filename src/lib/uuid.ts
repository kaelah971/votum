/**
 * Generate a cryptographically secure RFC 4122 UUID v4.
 *
 * Prefers `crypto.randomUUID()` (available on secure origins).
 * Falls back to `crypto.getRandomValues()` on insecure contexts
 * (private-network HTTP, some WebViews). Never uses Math.random().
 *
 * The fallback builds a 16-byte array, sets version bits (byte 6)
 * and variant bits (byte 8), then formats as canonical UUID.
 */
export function createUuidV4(): string {
  // Primary path: native randomUUID (secure origins only)
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  // Fallback: getRandomValues + manual RFC 4122 v4 construction
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    // Set version 4: byte 6 high nibble = 0100
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    // Set variant 10xx: byte 8 high nibble = 10xx
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");

    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join("-");
  }

  throw new Error(
    "Secure random number generation is not available in this environment.",
  );
}
