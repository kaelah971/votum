"use client";

import type { ChangeEvent } from "react";
import type { ExploreSortMode } from "@/lib/explore/filters";
import { SearchIcon } from "@/components/ui/icons";

const STATUS_FILTERS = [
  { value: "all", label: "All polls" },
  { value: "live", label: "Live" },
  { value: "closed", label: "Closed" },
] as const;

const SORT_OPTIONS: { value: ExploreSortMode; label: string }[] = [
  { value: "grouped", label: "Grouped by status" },
  { value: "recent", label: "Recently created" },
  { value: "closing", label: "Closing first" },
];

interface ExploreToolbarProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  statusFilter: "all" | "live" | "closed";
  onStatusChange: (value: "all" | "live" | "closed") => void;
  sortBy: ExploreSortMode;
  onSortChange: (value: ExploreSortMode) => void;
}

export function ExploreToolbar({
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusChange,
  sortBy,
  onSortChange,
}: ExploreToolbarProps) {
  return (
    <div className="flex flex-col gap-3">
      {/* Search */}
      <div className="relative w-full">
        <input
          type="text"
          value={searchQuery}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            onSearchChange(e.target.value)
          }
          placeholder="Search public polls"
          aria-label="Search public polls"
          className="w-full rounded-full border border-border bg-clear-ballot/72 py-2.5 pl-10 pr-4 text-sm text-ballot-ink placeholder:text-micro-grey transition-colors focus:border-signal-gold focus:outline-none focus:ring-1 focus:ring-signal-gold"
        />
        <SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 text-micro-grey" />
      </div>

      {/* Status + Sort row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Status filter">
          {STATUS_FILTERS.map((filter) => {
            const isActive = statusFilter === filter.value;
            return (
              <button
                key={filter.value}
                type="button"
                onClick={() => onStatusChange(filter.value)}
                aria-pressed={isActive}
                className={`rounded-full px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold ${
                  isActive
                    ? "bg-ballot-ink text-clear-ballot"
                    : "border border-border bg-clear-ballot/60 text-quiet-ink hover:bg-clear-ballot"
                }`}
              >
                {filter.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="explore-sort" className="text-sm text-quiet-ink">
            Sort polls
          </label>
          <select
            id="explore-sort"
            value={sortBy}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              onSortChange(e.target.value as ExploreSortMode)
            }
            className="rounded-full border border-border bg-clear-ballot/60 px-3.5 py-2 text-sm text-ballot-ink focus:border-signal-gold focus:outline-none focus:ring-1 focus:ring-signal-gold"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
