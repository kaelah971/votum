import { Card } from "@/components/ui/Card";
import { formatNimAmount } from "@/lib/nimiq/units";
import type { ProfileStats } from "@/lib/profiles/types";

/**
 * Derived profile stats — never editable. NIM earned is truthfully 0 until
 * the authoritative reward settlement ledger exists.
 */
export function ProfileStats({ stats }: { stats: ProfileStats }) {
  const items = [
    { label: "Participations", value: String(stats.participations) },
    { label: "Polls created", value: String(stats.pollsCreated) },
    { label: "NIM earned", value: formatNimAmount(BigInt(stats.nimEarnedLuna)) },
    { label: "NIM supported", value: formatNimAmount(BigInt(stats.nimSupportedLuna)) },
  ];

  return (
    <Card className="p-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {items.map((item) => (
          <div key={item.label} className="flex flex-col gap-0.5">
            <span className="font-display text-card-heading text-ballot-ink">
              {item.value}
            </span>
            <span className="text-micro text-quiet-ink">{item.label}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
