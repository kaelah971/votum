export function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function truncateTxHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

export function formatClosingTime(date: Date): string {
  // Split date and time into separate deterministic parts. Passing date AND
  // time options to a single toLocale* call produces an engine-dependent
  // combined pattern ("Aug 22, 2026, 1:42 AM" in Node ICU vs
  // "Aug 22, 2026 at 1:42 AM" in WebKit) that breaks SSR/client hydration.
  const datePart = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timePart = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${datePart}, ${timePart}`;
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
