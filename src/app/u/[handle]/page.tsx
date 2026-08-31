import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProductShell } from "@/components/layout/ProductShell";
import { PublicProfileView } from "@/components/profile/PublicProfileView";
import { getPublicProfileByHandle } from "@/lib/profiles/queries";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const result = await getPublicProfileByHandle(handle);
  const name = result?.profile?.displayName ?? "Votum participant";
  return {
    title: `${name} | Votum`,
    description: "A verified Votum participant and their public activity.",
  };
}

/**
 * Friendly handle route — resolves to the same underlying profile as the
 * canonical /profile/[wallet] route. Handle changes never affect the wallet
 * route; no old-handle redirects exist in V2B.1.
 */
export default async function HandleProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const result = await getPublicProfileByHandle(handle);

  if (!result || !result.profile) {
    notFound();
  }

  return (
    <ProductShell>
      <PublicProfileView data={result} />
    </ProductShell>
  );
}
