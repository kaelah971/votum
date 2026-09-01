import Link from "next/link";
import { ProductShell } from "@/components/layout/ProductShell";
import { Card } from "@/components/ui/Card";
import { CreatorManagementGate } from "@/components/creator/CreatorManagementGate";

/**
 * Creator poll detail route — truthful default state.
 *
 * No poll data is fabricated. Creator controls are gated client-side by
 * wallet connection, verified session, and creator-wallet ownership.
 *
 * This is a server component — wallet state is handled client-side by the
 * CreatorManagementGate.
 */
export default async function MyPollDetailPage({
  params,
}: {
  params: Promise<{ pollId: string }>;
}) {
  const { pollId } = await params;

  return (
    <ProductShell>
      {/* Eyebrow */}
      <Card glass className="mb-6 p-6">
        <p className="text-micro text-quiet-ink tracking-wider">
          CREATOR POLL DETAIL
        </p>
        <h1 className="mt-3 font-display text-page-title text-ballot-ink">
          Poll management.
        </h1>
      </Card>

      <CreatorManagementGate pollId={pollId} />

      {/* Back to My Polls link */}
      <div className="flex justify-center mt-8">
        <Link
          href="/my-polls"
          className="text-body text-quiet-ink hover:text-ballot-ink transition-colors"
        >
          Back to My Polls
        </Link>
      </div>
    </ProductShell>
  );
}
