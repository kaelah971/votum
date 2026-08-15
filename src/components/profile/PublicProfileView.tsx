import { Card } from "@/components/ui/Card";
import { ProfileHeader } from "@/components/profile/ProfileHeader";
import { ProfileStats } from "@/components/profile/ProfileStats";
import { RecentActivity } from "@/components/profile/RecentActivity";
import type { ParticipantPublicProfile } from "@/lib/profiles/types";

/**
 * Assembles the public profile surface (header + stats + recent activity).
 * Pure presentational component — data arrives already allowlisted.
 */
export function PublicProfileView({ data }: { data: ParticipantPublicProfile }) {
  const profile = data.profile;
  if (!profile) return null;

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <ProfileHeader profile={profile} />
      </Card>
      <ProfileStats stats={data.stats} />
      <RecentActivity activity={data.activity} />
    </div>
  );
}
