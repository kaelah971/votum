import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Explore",
  description:
    "Discover public Votum polls. See what verified communities are choosing and which campaigns have funded rewards.",
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
