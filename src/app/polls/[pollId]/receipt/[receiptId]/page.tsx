import type { Metadata } from "next";
import Link from "next/link";
import { ProductShell } from "@/components/layout/ProductShell";
import { UnavailableState } from "@/components/state/UnavailableState";
import { Card } from "@/components/ui/Card";

/**
 * Receipt route — truthful default state.
 *
 * No receipt data is fabricated. The route renders an UnavailableState
 * with the canonical messaging for when no receipt exists yet.
 */

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Votum Receipt",
    description:
      "A Votum Receipt will appear here after a verified vote is recorded.",
  };
}

export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ pollId: string; receiptId: string }>;
}) {
  // URL params are received but NOT used to fabricate data.
  void params;

  return (
    <ProductShell>
      {/* Eyebrow */}
      <Card glass className="mb-6 p-6">
        <p className="text-micro text-quiet-ink tracking-wider">
          VOTUM RECEIPT
        </p>
        <h1 className="mt-3 font-display text-page-title text-ballot-ink">
          Proof receipt.
        </h1>
      </Card>

      {/* Unavailable state — truthful: no receipt data exists */}
      <UnavailableState
        title="This receipt is not available yet."
        description="A Votum Receipt will appear here after a verified vote is recorded."
      />

      {/* Gold pill CTA to explore public polls */}
      <div className="flex justify-center mt-6">
        <Link
          href="/explore"
          className="inline-flex items-center justify-center rounded-full bg-signal-gold text-ballot-ink hover:bg-deep-gold font-medium transition-colors px-6 py-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold focus-visible:ring-offset-2"
        >
          Explore public polls
        </Link>
      </div>
    </ProductShell>
  );
}
