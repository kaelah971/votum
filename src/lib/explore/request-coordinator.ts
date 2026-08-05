/**
 * V2A.7F Explore Request Coordinator
 *
 * Manages independent request lifecycles with per-slot generation tracking.
 * Each slot has its own AbortController and request generation counter.
 *
 * Slots: firstPage, flatMore, closing_soon, live_now, recently_closed.
 */

import type { PollSection } from "@/lib/explore/filters";

export interface RequestHandle {
  readonly ac: AbortController;
  readonly slot: string;
  readonly filterGen: number;
  readonly reqGen: number;
}

export interface ExploreRequestCoordinator {
  startFirstPage(): RequestHandle;
  startFlatMore(): RequestHandle;
  startSectionMore(section: PollSection): RequestHandle;
  advanceFilterGeneration(): void;
  isCurrent(handle: RequestHandle): boolean;
  finish(handle: RequestHandle): void;
  dispose(): void;
}

export function createExploreRequestCoordinator(): ExploreRequestCoordinator {
  let filterGen = 1;

  // Per-slot state
  const slots = new Map<string, { ac: AbortController | null; gen: number }>();

  function getSlot(key: string) {
    let s = slots.get(key);
    if (!s) { s = { ac: null, gen: 0 }; slots.set(key, s); }
    return s;
  }

  function abort(ac: AbortController | null): void {
    if (ac) { try { ac.abort(); } catch { /* ok */ } }
  }

  function startSlot(key: string): RequestHandle {
    const s = getSlot(key);
    abort(s.ac);
    s.gen += 1;
    s.ac = new AbortController();
    return { ac: s.ac, slot: key, filterGen, reqGen: s.gen };
  }

  function isCurrentHandle(handle: RequestHandle): boolean {
    if (handle.filterGen !== filterGen) return false;
    const s = slots.get(handle.slot);
    if (!s) return false;
    return handle.reqGen === s.gen;
  }

  function abortAll(): void {
    for (const s of slots.values()) { abort(s.ac); s.ac = null; }
  }

  return {
    startFirstPage(): RequestHandle { return startSlot("firstPage"); },
    startFlatMore(): RequestHandle { return startSlot("flatMore"); },
    startSectionMore(section: PollSection): RequestHandle { return startSlot(`section:${section}`); },

    advanceFilterGeneration(): void {
      filterGen += 1;
      abortAll();
    },

    isCurrent(handle: RequestHandle): boolean {
      return isCurrentHandle(handle);
    },

    finish(_req: RequestHandle): void { void _req; },

    dispose(): void {
      this.advanceFilterGeneration();
    },
  };
}
