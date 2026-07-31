import { listPublicPolls } from "@/lib/data/public-polls";
import { getConfigStatus } from "@/lib/supabase/config";
import { ExploreClient } from "@/components/explore/ExploreClient";

export const dynamic = "force-dynamic";

export default async function ExplorePage() {
  const config = getConfigStatus();

  if (!config.configured) {
    return (
      <ExploreClient
        polls={null}
        configUnavailable={true}
        errorMessage={null}
      />
    );
  }

  const result = await listPublicPolls();

  if (!result.success) {
    return (
      <ExploreClient
        polls={null}
        configUnavailable={false}
        errorMessage={result.message}
      />
    );
  }

  return (
    <ExploreClient
      polls={result.polls}
      configUnavailable={false}
      errorMessage={null}
    />
  );
}
