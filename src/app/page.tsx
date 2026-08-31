import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/layout/MarketingShell";
import { ReferenceCapsuleStrip } from "@/components/layout/ReferenceCapsuleStrip";
import { HeroProofVisual } from "@/components/marketing/HeroProofVisual";
import { ProofPath } from "@/components/ui/ProofPath";
import { ArrowUpRightIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Verified decisions. Rewards when participation is funded.",
  description:
    "Create a free verified poll or fund a reward for eligible participants. Every verified wallet gets one vote.",
};

const linkPillPrimary =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-signal-gold px-6 text-sm font-medium text-ballot-ink transition-colors hover:bg-deep-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold focus-visible:ring-offset-2";

const linkPillSecondary =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-border bg-clear-ballot/50 px-6 text-sm font-medium text-ballot-ink transition-colors hover:bg-clear-ballot/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold focus-visible:ring-offset-2";

function CapsuleIcon({ tone }: { tone: "gold" | "blue" | "green" }) {
  const toneClasses = {
    gold: "bg-signal-gold text-ballot-ink",
    blue: "bg-nim-blue text-white",
    green: "bg-verified-green text-white",
  };

  return (
    <span
      className={`flex h-full w-full items-center justify-center ${toneClasses[tone]}`}
    >
      <ArrowUpRightIcon />
    </span>
  );
}

export default function Home() {
  return (
    <MarketingShell>
      <section className="grid min-h-[620px] grid-cols-1 content-between gap-10 py-10 lg:grid-cols-[0.82fr_1.18fr] lg:py-14">
        <div className="flex max-w-[560px] flex-col justify-center">
          <div className="mb-5 flex items-center gap-3 text-micro uppercase tracking-[0.03em] text-ballot-ink">
            <ArrowUpRightIcon />
            Verified community decisions
          </div>

          <h1 className="font-display text-[3.25rem] font-medium leading-[0.98] text-ballot-ink sm:text-[4.6rem] lg:text-[5.4rem]">
            Decide together. <span className="hero-living-word">Reward</span> participation.
          </h1>

          <p className="mt-6 max-w-[460px] text-body-lg text-quiet-ink">
            Create a free verified poll or fund a reward for eligible participants.
            Every verified wallet gets one vote.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/create" className={linkPillPrimary}>
              Create poll
            </Link>
            <Link href="/explore" className={linkPillSecondary}>
              Browse public polls
            </Link>
          </div>

          <div className="mt-10">
            <ProofPath />
          </div>

          <div className="mt-10 grid max-w-[430px] grid-cols-3 gap-4 text-micro text-ballot-ink">
            <div>
              <p className="font-proof">1 wallet</p>
              <p className="mt-1 text-quiet-ink">one vote</p>
            </div>
            <div>
              <p className="font-proof">NIM proof</p>
              <p className="mt-1 text-quiet-ink">verified</p>
            </div>
            <div>
              <p className="font-proof">public link</p>
              <p className="mt-1 text-quiet-ink">shareable</p>
            </div>
          </div>
        </div>

        <div className="relative flex min-h-[360px] items-center justify-center lg:min-h-[560px]">
          <HeroProofVisual />
        </div>

        <ReferenceCapsuleStrip
          className="lg:col-span-2"
          items={[
            {
               title: "Create a free verified poll",
               meta: "One verified wallet, one vote",
              visual: <CapsuleIcon tone="gold" />,
              action: (
                <Link
                  href="/create"
                  className="rounded-full bg-ballot-ink px-4 py-2 text-xs font-medium text-clear-ballot"
                >
                  Add
                </Link>
              ),
            },
            {
               title: "Fund participation rewards",
               meta: "Rewards never depend on the selected option",
              visual: <CapsuleIcon tone="blue" />,
              action: (
                <Link
                  href="/how-it-works"
                  className="rounded-full bg-ballot-ink px-4 py-2 text-xs font-medium text-clear-ballot"
                >
                  View
                </Link>
              ),
            },
            {
              title: "Receipt after confirmation",
              meta: "A data-minimised proof surface",
              visual: <CapsuleIcon tone="green" />,
              action: (
                <Link
                  href="/explore"
                  className="rounded-full bg-ballot-ink px-4 py-2 text-xs font-medium text-clear-ballot"
                >
                  Go
                </Link>
              ),
            },
          ]}
        />
      </section>
    </MarketingShell>
  );
}
