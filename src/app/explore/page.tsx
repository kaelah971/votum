import { getConfigStatus } from "@/lib/supabase/config";
import { ExploreClient } from "@/components/explore/ExploreClient";
import { parseExploreParams } from "@/lib/explore/url-params";
import { queryExploreFlat, queryExploreGrouped } from "@/lib/data/explore-queries";
import type { ExploreQueryResult, GroupedExploreResult } from "@/lib/explore/types";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function ExplorePage({ searchParams }: PageProps) {
  const rawParams = await searchParams;
  const currentTime = new Date().toISOString();
  const config = getConfigStatus();

  if (!config.configured) {
    return (
      <ExploreClient
        configUnavailable={true}
        errorMessage={null}
        currentTime={currentTime}
        initialFilters={null}
        initialResult={null}
      />
    );
  }

  // Normalize incoming URL params
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(rawParams)) {
    if (typeof v === "string") sp.set(k, v);
  }
  const filters = parseExploreParams(sp);

  let initialResult: ExploreQueryResult | GroupedExploreResult;
  let errorMsg: string | null = null;

  if (filters.sort === "grouped") {
    initialResult = await queryExploreGrouped({
      search: filters.search, category: filters.category,
      format: filters.format, status: filters.status, rewarded: filters.rewarded,
      sort: "grouped", limit: 4,
    }).catch((err: unknown) => {
      errorMsg = err instanceof Error ? err.message : "Could not load Explore";
      return null as unknown as ExploreQueryResult | GroupedExploreResult;
    });
  } else {
    initialResult = await queryExploreFlat({
      search: filters.search, category: filters.category,
      format: filters.format, status: filters.status, rewarded: filters.rewarded,
      sort: filters.sort, limit: 12,
    }).catch((err: unknown) => {
      errorMsg = err instanceof Error ? err.message : "Could not load Explore";
      return null as unknown as ExploreQueryResult | GroupedExploreResult;
    });
  }

  return (
      <ExploreClient
        configUnavailable={false}
        errorMessage={errorMsg}
        currentTime={currentTime}
        initialFilters={errorMsg ? null : filters}
        initialResult={errorMsg ? null : initialResult!}
      />
  );
}
