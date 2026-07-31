"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ProductShell } from "@/components/layout/ProductShell";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/state/EmptyState";
import { listDrafts, deleteDraft } from "@/lib/drafts/storage";
import type { PollDraft } from "@/lib/drafts/types";

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const stepLabel: Record<string, string> = {
  decision: "Decision",
  support: "Support",
  review: "Review",
};

const statusLabel: Record<string, string> = {
  editing: "Editing",
  awaiting_wallet: "Needs wallet",
  awaiting_verification: "Needs verification",
  ready_to_publish: "Ready",
};

export default function DraftsPage() {
  const [drafts, setDrafts] = useState<PollDraft[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    setDrafts(listDrafts());
    setLoaded(true);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional hydration from localStorage
    load();
  }, [load]);

  const handleDelete = useCallback(
    (id: string) => {
      if (!window.confirm("Delete this draft?")) return;
      deleteDraft(id);
      load();
    },
    [load],
  );

  if (!loaded) return null;

  return (
    <ProductShell>
      <header className="mb-8">
        <div className="flex items-center gap-1.5 text-micro text-quiet-ink tracking-wider mb-2">
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M3.5 8.5L8.5 3.5M8.5 3.5H4.5M8.5 3.5V7.5"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          SAVED POLLS
        </div>
        <h1 className="text-section-heading font-display text-ballot-ink">
          Drafts
        </h1>
        <p className="text-body text-quiet-ink mt-2">
          Unfinished polls are saved automatically as you work.
        </p>
      </header>

      {drafts.length === 0 ? (
        <EmptyState
          title="No saved drafts yet."
          description="Start a new poll to create your first draft. Drafts save automatically and are stored locally in this browser."
          action={
            <Link href="/create">
              <span className="inline-flex items-center justify-center rounded-full bg-signal-gold text-ballot-ink hover:bg-deep-gold font-medium transition-colors px-6 py-3 text-sm">
                Create a Votum Poll
              </span>
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          {drafts.map((draft) => (
            <Card key={draft.id} className="p-5">
              <div className="flex flex-col gap-3">
                <div className="flex-1 min-w-0">
                  <h3 className="text-card-heading font-display text-ballot-ink line-clamp-2">
                    {draft.question.trim() || "Untitled poll"}
                  </h3>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className="text-micro text-quiet-ink">
                      {stepLabel[draft.currentStep] ?? draft.currentStep}
                    </span>
                    <span className="text-micro text-quiet-ink">·</span>
                    <span className="text-micro text-quiet-ink">
                      {draft.options.length} option
                      {draft.options.length !== 1 ? "s" : ""}
                    </span>
                    <span className="text-micro text-quiet-ink">·</span>
                    <span className="text-micro text-quiet-ink">
                      {formatTime(draft.updatedAt)}
                    </span>
                  </div>
                  <span
                    className={`inline-block mt-2 text-micro font-medium rounded-full px-2.5 py-0.5 ${
                      draft.status === "ready_to_publish"
                        ? "bg-verified-green/10 text-verified-green"
                        : draft.status === "awaiting_wallet" ||
                            draft.status === "awaiting_verification"
                          ? "bg-fairness-amber/10 text-fairness-amber"
                          : "bg-soft-fog text-quiet-ink"
                    }`}
                  >
                    {statusLabel[draft.status] ?? draft.status}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Link
                    href={`/create?draft=${draft.id}`}
                    className="inline-flex flex-1 justify-center sm:flex-initial items-center rounded-full bg-signal-gold text-ballot-ink hover:bg-deep-gold font-medium transition-colors px-4 py-2.5 text-sm min-h-[44px]"
                  >
                    Continue
                  </Link>
                  <button
                    type="button"
                    onClick={() => handleDelete(draft.id)}
                    className="inline-flex items-center justify-center w-10 h-10 rounded-full text-quiet-ink hover:text-reject-red hover:bg-soft-fog transition-colors flex-shrink-0"
                    aria-label={`Delete draft: ${draft.question || "Untitled"}`}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M4 4L12 12M12 4L4 12"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </ProductShell>
  );
}
