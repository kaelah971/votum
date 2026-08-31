import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProductShell } from "@/components/layout/ProductShell";
import { PublicProfileView } from "@/components/profile/PublicProfileView";
import { getPublicProfileByWallet } from "@/lib/profiles/queries";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ wallet: string }>;
}): Promise<Metadata> {
  const { wallet } = await params;
  const result = await getPublicProfileByWallet(wallet);
  const name = result?.profile?.displayName ?? "Votum participant";
  return {
    title: `${name} | Votum`,
    description: "A verified Votum participant and their public activity.",
  };
}

/**
 * Canonical participant profile route. Accepts canonical hex or NQ wallet
 * forms; both resolve to the same profile. Unknown/malformed wallets 404.
 */
export default async function ProfilePage({
  params,
}: {
  params: Promise<{ wallet: string }>;
}) {
  const { wallet } = await params;
  const result = await getPublicProfileByWallet(wallet);

  if (!result || !result.profile) {
    notFound();
  }

  return (
    <ProductShell>
      <PublicProfileView data={result} />
    </ProductShell>
  );
}
