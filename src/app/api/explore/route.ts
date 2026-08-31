import { NextResponse } from "next/server";
import { parseExploreParams } from "@/lib/explore/url-params";
import { queryExploreFlat, queryExploreGrouped } from "@/lib/data/explore-queries";
import type { ExploreSortMode, PollSection } from "@/lib/explore/filters";

export const runtime = "nodejs";

const VALID_SECTIONS: ReadonlySet<string> = new Set([
  "closing_soon", "live_now", "recently_closed",
]);

/**
 * GET /api/explore?q=&category=&format=&status=&sort=&section=&cursor=
 *
 * Calls the server query layer (anonymous publishable key, RLS-gated).
 * Returns sanitized JSON — raw errors are never exposed.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const filters = parseExploreParams(searchParams);

    const section = searchParams.get("section") ?? undefined;
    if (section !== undefined && !VALID_SECTIONS.has(section)) {
      return NextResponse.json(
        { error: "invalid_section", message: "Unknown grouped section" },
        { status: 400 },
      );
    }

    const cursor = searchParams.get("cursor") ?? undefined;

    const sort = (filters.sort as ExploreSortMode) || "grouped";

    if (sort === "grouped") {
      const result = await queryExploreGrouped({
        search: filters.search,
        category: filters.category,
         format: filters.format,
         status: filters.status,
         rewarded: filters.rewarded,
        sort: "grouped",
        section: section as PollSection | undefined,
        cursor,
        limit: section ? 12 : 4,
      });

      return NextResponse.json(result);
    }

    // Flat modes: recent or closing
    const result = await queryExploreFlat({
      search: filters.search,
      category: filters.category,
       format: filters.format,
       status: filters.status,
       rewarded: filters.rewarded,
      sort,
      cursor,
      limit: 12,
    });

    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Query failed";
    return NextResponse.json(
      { error: "query_failed", message },
      { status: 500 },
    );
  }
}
