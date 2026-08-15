import Link from "next/link";
import { Card } from "@/components/ui/Card";
import type { RecentActivityItem } from "@/lib/profiles/types";

/**
 * Recent public activity. Shows ONLY the public poll title — the chosen
 * option is structurally absent from this component's data contract.
 */
export function RecentActivity({ activity }: { activity: RecentActivityItem[] }) {
  if (activity.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="text-card-heading font-display text-ballot-ink mb-2">
          Recent activity
        </h2>
        <p className="text-body text-quiet-ink">
          No public activity yet.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <h2 className="text-card-heading font-display text-ballot-ink mb-3">
        Recent activity
      </h2>
      <ul className="space-y-3">
        {activity.map((item, index) => (
          <li
            key={`${item.kind}-${item.pollId}-${index}`}
            className="flex flex-col gap-0.5"
          >
            <Link
              href={`/polls/${item.pollId}`}
              className="text-body text-ballot-ink hover:text-signal-gold transition-colors line-clamp-2"
            >
              {item.kind === "created" ? "Created" : "Participated in"} “
              {item.question}”
            </Link>
            <span className="text-micro text-quiet-ink">
              {new Date(item.at).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
