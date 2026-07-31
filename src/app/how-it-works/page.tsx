import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/layout/MarketingShell";
import { ReferenceCapsuleStrip } from "@/components/layout/ReferenceCapsuleStrip";
import { Card } from "@/components/ui/Card";
import { FairnessLabel } from "@/components/ui/FairnessLabel";
import { ProofPath } from "@/components/ui/ProofPath";
import { ArrowUpRightIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "How Votum works",
  description:
    "From question to verified community signal. Learn how Votum helps communities make decisions using verified NIM-backed participation.",
};

const steps = [
  {
    label: "Question",
    copy: "A creator writes a clear decision and adds two to six meaningful choices.",
  },
  {
    label: "Support",
    copy: "The poll states what the NIM supports, the minimum amount, and the destination wallet.",
  },
  {
    label: "Verify",
    copy: "A participant backs one choice through Nimiq Pay before Votum records the vote.",
  },
  {
    label: "Result",
    copy: "Wallet count and NIM signal are shown separately so commitment never becomes extra voting power.",
  },
];

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

        <Card glass className="p-5 sm:p-7">
          <div className="mb-8 flex flex-wrap items-center gap-2">
            {["Creator flow", "Voter flow", "Fairness"].map((tab, index) => (
              <span
                key={tab}
                className={`rounded-full px-4 py-2 text-xs font-medium ${
                  index === 0
                    ? "bg-ballot-ink text-clear-ballot"
                    : "border border-border bg-clear-ballot/50 text-quiet-ink"
                }`}
              >
                {tab}
              </span>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {steps.map((step, index) => (
              <div
                key={step.label}
                className="rounded-[22px] border border-divider bg-clear-ballot/72 p-5"
              >
                <p className="font-proof text-sm text-signal-gold">
                  0{index + 1}
                </p>
                <h2 className="mt-4 font-display text-card-heading text-ballot-ink">
                  {step.label}
                </h2>
                <p className="mt-2 text-body text-quiet-ink">{step.copy}</p>
              </div>
            ))}
          </div>

          <div className="mt-6 rounded-[22px] border border-fairness-amber/20 bg-fairness-amber/[0.04] p-5">
            <FairnessLabel rule="One wallet - one vote" />
            <p className="mt-3 text-body text-quiet-ink">
              Contributing more NIM never silently creates more votes. Breadth
              of participation and depth of support stay visible as separate
              signals.
            </p>
          </div>
        </Card>
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
