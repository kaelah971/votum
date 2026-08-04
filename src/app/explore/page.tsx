import { listPublicPolls } from "@/lib/data/public-polls";
import { getConfigStatus } from "@/lib/supabase/config";
import { ExploreClient } from "@/components/explore/ExploreClient";

export const dynamic = "force-dynamic";

export default async function ExplorePage() {
  const config = getConfigStatus();
  const currentTime = new Date().toISOString();

  if (!config.configured) {
    return (
      <ExploreClient
        polls={null}
        configUnavailable={true}
        errorMessage={null}
        currentTime={currentTime}
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
        currentTime={currentTime}
      />
    );
  }

  return (
    <ExploreClient
      polls={result.polls}
      configUnavailable={false}
      errorMessage={null}
      currentTime={currentTime}
    />
  );
}
