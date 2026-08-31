"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { FairnessLabel } from "@/components/ui/FairnessLabel";

const tabs = ["Creator flow", "Voter flow", "Fairness"] as const;

const creatorSteps = [
  { label: "Question", copy: "A creator writes a clear decision and adds two to six meaningful choices." },
  { label: "Rewards", copy: "The creator chooses free voting or defines a fixed reward budget for eligible participants." },
  { label: "Publish", copy: "Votum publishes the poll and makes it available for verified community participation." },
  { label: "Understand", copy: "The creator tracks votes, option performance, and the status of any reward campaign." },
];

const voterSteps = [
  { label: "Discover", copy: "A participant opens a live poll from Explore or a shared link." },
  { label: "Verify", copy: "The participant connects and verifies a Nimiq wallet before voting." },
  { label: "Vote", copy: "One verified wallet selects one option and receives exactly one vote." },
  { label: "Reward", copy: "If participation is funded, eligible participants can earn the same predefined reward regardless of their choice." },
];

const fairnessItems = [
  { label: "One wallet · one vote", copy: "Each verified wallet can vote only once in a poll." },
  { label: "Separate signals", copy: "Vote count shows verified participation. Any reward campaign remains separate from the selected option." },
  { label: "Fixed rewards", copy: "A funded campaign uses one predefined reward per eligible participant, independent of the result." },
  { label: "Verifiable results", copy: "Votes are database-enforced and one verified wallet can participate only once." },
];

export function HowItWorksTabs() {
  const [selected, setSelected] = useState(0);

  return (
    <Card glass className="p-5 sm:p-7">
      <div className="mb-8 flex flex-wrap items-center gap-2" role="tablist" aria-label="How Votum works">
        {tabs.map((tab, index) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={selected === index}
            onClick={() => setSelected(index)}
            className={`rounded-full px-4 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold focus-visible:ring-offset-2 ${
              selected === index
                ? "bg-ballot-ink text-clear-ballot"
                : "border border-border bg-clear-ballot/50 text-quiet-ink hover:bg-soft-fog"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="grid gap-4 sm:grid-cols-2">
        {(selected === 0 ? creatorSteps : selected === 1 ? voterSteps : fairnessItems).map((step, i) => (
          <div key={step.label} className="rounded-[22px] border border-divider bg-clear-ballot/72 p-5">
            <p className="font-proof text-sm text-signal-gold">0{i + 1}</p>
            <h2 className="mt-4 font-display text-card-heading text-ballot-ink">{step.label}</h2>
            <p className="mt-2 text-body text-quiet-ink">{step.copy}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-[22px] border border-fairness-amber/20 bg-fairness-amber/[0.04] p-5">
        <FairnessLabel rule="One wallet - one vote" />
        <p className="mt-3 text-body text-quiet-ink">
           Every verified wallet gets one vote. Rewards, when funded, never
           depend on choosing a particular option.
        </p>
      </div>
    </Card>
  );
}
