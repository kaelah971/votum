import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "My Polls",
  description:
    "View and manage the Votum Polls created by your wallet. Track participation, NIM signal, and community results.",
};

/**
 * Layout wrapper for /my-polls — provides route-level metadata.
 * The page component is a client component and cannot export metadata
 * directly, so this server-component layout bridges that gap.
 */
export default function MyPollsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
