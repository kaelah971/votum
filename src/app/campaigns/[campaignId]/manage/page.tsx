import { ProductShell } from "@/components/layout/ProductShell";
import { CampaignManageView } from "@/components/campaign/CampaignManageView";

export default async function ManageCampaignPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;

  return (
    <ProductShell>
      <CampaignManageView campaignId={campaignId} />
    </ProductShell>
  );
}
