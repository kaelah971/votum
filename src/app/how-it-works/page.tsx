import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/layout/MarketingShell";
import { ReferenceCapsuleStrip } from "@/components/layout/ReferenceCapsuleStrip";
import { ProofPath } from "@/components/ui/ProofPath";
import { ArrowUpRightIcon } from "@/components/ui/icons";
import { HowItWorksTabs } from "@/components/marketing/HowItWorksTabs";

export const metadata: Metadata = {
  title: "How Votum works",
  description:
    "From question to verified community signal. Learn how Votum helps communities make decisions using verified NIM-backed participation.",
};

const linkPillPrimary =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-signal-gold px-6 text-sm font-medium text-ballot-ink transition-colors hover:bg-deep-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold focus-visible:ring-offset-2";

export default function HowItWorks() {
  return (
    <MarketingShell>
      <section className="grid gap-10 py-10 lg:grid-cols-[0.86fr_1.14fr] lg:py-14">
        <div>
          <div className="mb-5 flex items-center gap-3 text-micro uppercase tracking-[0.03em] text-ballot-ink">
            <ArrowUpRightIcon />
            How Votum works
          </div>
          <h1 className="max-w-[560px] font-display text-[3rem] font-medium leading-[1.02] text-ballot-ink sm:text-[4.4rem]">
            From question to verified community signal.
          </h1>
          <p className="mt-6 max-w-[520px] text-body-lg text-quiet-ink">
            Votum keeps the flow simple: ask, choose, back the choice with NIM,
            and show a verified result without turning the contribution into a
            wager.
          </p>
          <div className="mt-8">
            <ProofPath />
          </div>
          <Link href="/create" className={`${linkPillPrimary} mt-10`}>
            Create a Votum Poll
          </Link>
        </div>

        <HowItWorksTabs />
      </section>

      <ReferenceCapsuleStrip
        className="pb-12"
        items={[
          {
            title: "Transparent destination",
            meta: "Shown before confirmation",
            visual: <span className="font-proof text-sm">NQ</span>,
          },
          {
            title: "Verified participation",
            meta: "Recorded after payment proof",
            visual: <span className="text-lg">OK</span>,
          },
          {
            title: "Receipt-ready result",
            meta: "Public proof, private wallet detail",
            visual: <ArrowUpRightIcon />,
          },
        ]}
      />
    </MarketingShell>
  );
}
