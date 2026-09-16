import { notFound } from "next/navigation";
import { ProductShell } from "@/components/layout/ProductShell";
import { UnavailableState } from "@/components/state/UnavailableState";
import { CampaignGiveawayView } from "@/components/campaign/CampaignGiveawayView";
import { getPublicCampaignGiveaway } from "@/lib/campaigns/public-giveaway";
import { createAdminClient, getAdminConfigStatus } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export async function generateMetadata({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;

  if (getAdminConfigStatus().configured) {
    const admin = createAdminClient();
    if (admin) {
      const giveaway = await getPublicCampaignGiveaway(admin, campaignId);
      if (giveaway) {
        return {
          title: giveaway.title,
          description:
            giveaway.description ?? "View a verified community reward on Votum.",
        };
      }
    }
  }

  return {
    title: "Votum Campaign",
    description:
      "View a verified community reward. Campaign data is fetched from the Votum data layer.",
  };
}

// ---------------------------------------------------------------------------
// Page component (server component)
// ---------------------------------------------------------------------------

export default async function CampaignPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;

  if (!getAdminConfigStatus().configured) {
    return (
      <ProductShell>
        <UnavailableState
          title="Campaign data is not available"
          description="Campaign data will appear here once the Votum data layer is connected."
        />
      </ProductShell>
    );
  }

  const admin = createAdminClient();
  if (!admin) {
    return (
      <ProductShell>
        <UnavailableState
          title="Campaign data is not available"
          description="Campaign data will appear here once the Votum data layer is connected."
        />
      </ProductShell>
    );
  }

  // Server-only projection: only the returned public DTO crosses into the
  // rendered output. No wallet, challenge, receipt, vault, or own-claim
  // reads happen in this slice.
  const giveaway = await getPublicCampaignGiveaway(admin, campaignId);
  if (!giveaway) notFound();

  return (
    <ProductShell>
      <CampaignGiveawayView giveaway={giveaway} />
    </ProductShell>
  );
}
