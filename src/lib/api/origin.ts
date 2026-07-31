export function getServerOrigin(): string | null {
  const url = process.env.NEXT_PUBLIC_APP_URL;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Validate that an origin's hostname is a loopback address or a
 * private-network IPv4 address (RFC 1918).  Used only as a fallback
 * when NEXT_PUBLIC_APP_URL is not configured (local dev / Nimiq Pay
 * testing on a LAN).
 *
 * Using proper URL parsing and subnet regexes prevents naive
 * `startsWith` bypasses such as `http://10.evil.com`.
 */
function isPrivateOrLoopbackHost(hostname: string): boolean {
  // Loopback (IPv4, IPv6, and the "localhost" alias)
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  ) {
    return true;
  }

  // 10.0.0.0/8
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  // 172.16.0.0/12
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  // 192.168.0.0/16
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;

  return false;
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  // Same-origin requests typically omit the Origin header for GET/HEAD.
  // If absent, we conservatively treat the request as same-origin.
  if (!origin) return true;

  const serverOrigin = getServerOrigin();
  // When running locally (no production URL configured), allow common
  // private / loopback origins so development works out of the box.
  if (!serverOrigin) {
    try {
      const parsed = new URL(origin);
      return isPrivateOrLoopbackHost(parsed.hostname);
    } catch {
      return false;
    }
  }

  return origin === serverOrigin;
}
