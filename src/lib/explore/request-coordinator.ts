/**
 * V2A.7F.1A Explore Request Coordinator
 *
 * Manages independent request lifecycles for:
 *   1. Initial/filter-change requests (shared filter generation)
 *   2. Flat Load more requests
 *   3. Grouped per-section Load more requests
 *
 * Each grouped section has its own AbortController so that
 * Loading one section never cancels another section.
 *
 * Filter changes cancel ALL active requests from the old generation.
 */

import type { PollSection } from "@/lib/explore/filters";

export interface RequestHandle {
  ac: AbortController;
  gen: number;
  filterGen: number;
}

export interface ExploreRequestCoordinator {
  /** Start a new first-page request (initial load or filter change). */
  startFirstPage(): RequestHandle;
  /** Start a flat Load more request. */
  startFlatMore(): RequestHandle;
  /** Start a grouped section Load more request. */
  startSectionMore(section: PollSection): RequestHandle;

  /** True if this handle's generation is still current for its mode. */
  isCurrent(handle: RequestHandle): boolean;

  /** New filter generation — aborts ALL active requests. */
  advanceFilterGeneration(): void;
  /** Abort everything and reset state. Called on unmount. */
  destroy(): void;
}

export function createExploreRequestCoordinator(): ExploreRequestCoordinator {
  let filterGen = 1;

  let firstGen = 0;
  let firstAc: AbortController | null = null;

  let flatGen = 0;
  let flatAc: AbortController | null = null;

  const sectionGen: Partial<Record<PollSection, number>> = {};
  const sectionAc: Partial<Record<PollSection, AbortController | null>> = {};

  // ── Helpers ──────────────────────────────────────────────────────

  function newHandle(ac: AbortController, gen: number): RequestHandle {
    return { ac, gen, filterGen };
  }

  function abort(ac: AbortController | null): void {
    if (ac) { try { ac.abort(); } catch { /* ok */ } }
  }

  // ── Public API ───────────────────────────────────────────────────

  return {
    startFirstPage(): RequestHandle {
      abort(firstAc);
      firstGen += 1;
      firstAc = new AbortController();
      return newHandle(firstAc, firstGen);
    },

    startFlatMore(): RequestHandle {
      abort(flatAc);
      flatGen += 1;
      flatAc = new AbortController();
      return newHandle(flatAc, flatGen);
    },

    startSectionMore(section: PollSection): RequestHandle {
      abort(sectionAc[section] ?? null);
      const prev = sectionGen[section] ?? 0;
      sectionGen[section] = prev + 1;
      sectionAc[section] = new AbortController();
      return newHandle(sectionAc[section]!, sectionGen[section]!);
    },

    isCurrent(handle: RequestHandle): boolean {
      return handle.filterGen === filterGen;
    },

    advanceFilterGeneration(): void {
      filterGen += 1;
      // Abort ALL active requests from the old generation
      abort(firstAc); firstAc = null;
      abort(flatAc); flatAc = null;
      for (const sec of Object.keys(sectionAc) as PollSection[]) {
        abort(sectionAc[sec]!);
        sectionAc[sec] = null;
      }
    },

    destroy(): void {
      this.advanceFilterGeneration();
    },
  };
}
