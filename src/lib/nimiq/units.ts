export const LUNA_PER_NIM = BigInt(100000);

export const PG_BIGINT_MAX = BigInt("9223372036854775807");

/**
 * Convert a NIM decimal string to Luna as BigInt.
 *
 * Rules:
 *  - String only — no JavaScript number, no floating-point.
 *  - Optional decimal point with at most 5 fractional digits.
 *  - Rejects: empty, signs, exponents, commas, NaN, Infinity, overflow.
 *  - No rounding — excess precision is an error.
 *
 * Examples:
 *   "1"        → 100000n
 *   "1.0"      → 100000n
 *   "0.00001"  → 1n
 *   "1.23456"  → 123456n
 *   "10.5"     → 1050000n
 */
export function nimDecimalToLuna(value: string): bigint {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Value must not be empty");
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Value must be a non-negative decimal with no signs, commas, or exponents");
  }

  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > 5) throw new Error("At most 5 decimal places are allowed");

  const padded = frac.padEnd(5, "0");
  const wholeBig = BigInt(whole);
  const fracBig = BigInt(padded);

  const luna = wholeBig * LUNA_PER_NIM + fracBig;
  if (luna <= BigInt(0)) throw new Error("Minimum NIM must be greater than zero");
  if (luna > PG_BIGINT_MAX) throw new Error("NIM amount exceeds maximum Luna value");

  return luna;
}

export function lunaToNim(luna: bigint | number): number {
  if (typeof luna === "number") {
    if (!Number.isSafeInteger(luna) || luna < 0) {
      return 0;
    }
  }
  return Number(BigInt(luna)) / Number(LUNA_PER_NIM);
}

/**
 * @deprecated Use nimDecimalToLuna(value: string) for strict parsing.
 * This function uses floating-point and is kept only for display formatting.
 */
export function nimToLuna(nim: number): bigint {
  if (!Number.isFinite(nim) || nim < 0) return BigInt(0);
  return BigInt(Math.round(nim * Number(LUNA_PER_NIM)));
}

export function formatNimAmount(luna: bigint | number): string {
  const nim = lunaToNim(luna);

  if (nim === 0) return "0 NIM";

  if (Number.isInteger(nim)) {
    return `${nim.toLocaleString()} NIM`;
  }

  const fixed = nim.toFixed(6);
  const stripped = fixed.replace(/\.?0+$/, "");

  return `${Number(stripped).toLocaleString()} NIM`;
}

export function formatLunaRaw(luna: bigint | number): string {
  return `${BigInt(luna).toLocaleString()} Luna`;
}
