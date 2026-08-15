import { Badge } from "@/components/ui/Badge";
import { VerifiedCheckIcon } from "@/components/ui/icons";
import { truncateAddress, formatDate } from "@/lib/format";
import type { ParticipantProfile } from "@/lib/profiles/types";

/**
 * Public profile header: display name (or shortened-wallet fallback),
 * optional @handle, shortened wallet, Verified badge, joined date.
 */
export function ProfileHeader({ profile }: { profile: ParticipantProfile }) {
  return (
    <div className="flex flex-col gap-1.5">
      {profile.displayName && (
        <h1 className="font-display text-page-title text-ballot-ink">
          {profile.displayName}
        </h1>
      )}
      {profile.handle && (
        <p className="text-body text-nim-blue font-medium">@{profile.handle}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-proof text-micro text-quiet-ink">
          {truncateAddress(profile.walletAddress)}
        </span>
        <Badge variant="verified">
          <VerifiedCheckIcon className="w-3 h-3 mr-1" />
          Verified
        </Badge>
      </div>
      <p className="text-micro text-quiet-ink">
        Joined {formatDate(new Date(profile.joinedDate))}
      </p>
    </div>
  );
}
