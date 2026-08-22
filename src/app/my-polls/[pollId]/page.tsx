import Link from "next/link";
import { ProductShell } from "@/components/layout/ProductShell";
import { Card } from "@/components/ui/Card";
import { WalletButton } from "@/components/ui/WalletButton";
import { WalletIconLarge } from "@/components/ui/icons";
import { RewardFundingPanel } from "@/components/creator/RewardFundingPanel";

/**
 * Creator poll detail route — truthful default state.
 *
 * No poll data is fabricated. The route renders an inline
 * wallet-required state explaining that creator controls
 * are only available to the wallet that created the poll.
 *
 * This is a server component — wallet state is handled
 * client-side via the WalletButton.
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

      {/* Inline wallet-required state */}
      <Card glass className="mx-auto flex w-full max-w-md flex-col items-center justify-center px-5 py-16 text-center">
        <div className="mb-6 text-signal-gold opacity-80">
          <WalletIconLarge />
        </div>
        <h2 className="text-section-heading font-display text-ballot-ink text-center">
          Connect your wallet to manage this poll.
        </h2>
        <p className="text-body text-quiet-ink max-w-sm text-center mt-3">
          Creator controls are available only to the wallet that created the
          Votum Poll.
        </p>
        <div className="mt-8">
          <WalletButton />
        </div>
        <p className="text-micro text-quiet-ink text-center mt-6">
          Reward campaign funding appears below when this poll has a configured campaign.
        </p>
      </Card>

      <RewardFundingPanel pollId={pollId} />

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
