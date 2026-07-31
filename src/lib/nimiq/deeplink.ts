const APP_URL = process.env.NEXT_PUBLIC_APP_URL;

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

const PRIVATE_IPV4_RANGES: readonly [number, number][] = [
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16
];

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;

  const octets = parts.map((p) => parseInt(p, 10));
  if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return false;

  const ip = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;

  if (ip === 0) return true; // 0.0.0.0

  return PRIVATE_IPV4_RANGES.some(([start, end]) => ip >= start && ip <= end);
}

function isPrivateIPv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  if (normalized === "::1" || normalized === "[::1]") return true; // loopback
  if (normalized === "::" || normalized === "[::]") return true; // unspecified

  const stripped = normalized.replace(/^\[|\]$/g, "");

  if (stripped.startsWith("fc") || stripped.startsWith("fd")) return true; // fc00::/7
  if (stripped.startsWith("fe8") || stripped.startsWith("fe9") ||
      stripped.startsWith("fea") || stripped.startsWith("feb")) return true; // fe80::/10

  if (stripped.startsWith("::ffff:")) {
    const ipv4Part = stripped.slice(7);
    if (isPrivateIPv4(ipv4Part)) return true;
  }

  return false;
}

function isLocalNetwork(hostname: string): boolean {
  if (hostname === "localhost") return true;
  if (isPrivateIPv4(hostname)) return true;
  if (isPrivateIPv6(hostname)) return true;
  return false;
}

function canProduceProductionDeepLink(parsed: URL): boolean {
  if (parsed.protocol !== "https:") return false;
  if (isLocalNetwork(parsed.hostname)) return false;
  return true;
}

export function getNimiqPayDeepLink(): string | null {
  if (!APP_URL) return null;

  const trimmed = APP_URL.replace(/\/+$/, "");
  const parsed = parseUrl(trimmed);
  if (!parsed) return null;

  if (!canProduceProductionDeepLink(parsed)) return null;

  const encoded = encodeURIComponent(trimmed);
  return `nimiqpay://miniapp?url=${encoded}`;
}

export function getAppUrl(): string | null {
  if (!APP_URL) return null;
  return APP_URL.replace(/\/+$/, "");
}

export function isLocalNetworkUrl(): boolean {
  if (!APP_URL) return false;
  const trimmed = APP_URL.replace(/\/+$/, "");
  const parsed = parseUrl(trimmed);
  if (!parsed) return false;
  return isLocalNetwork(parsed.hostname);
}
