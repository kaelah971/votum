import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Explore",
  description:
    "Discover public Votum Polls. See what communities are choosing and what they care enough to support with NIM-backed votes.",
};

/**
 * Layout wrapper for /explore — provides route-level metadata.
 * The page component itself is a client component and cannot export
 * metadata directly, so this server-component layout bridges that gap.
 */
export default function ExploreLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
