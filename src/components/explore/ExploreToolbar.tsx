"use client";

import type { ChangeEvent } from "react";
import { Select } from "@/components/ui/Select";
import { SearchIcon } from "@/components/ui/icons";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SORT_OPTIONS = [
  { value: "recent", label: "Recently created" },
  { value: "closing", label: "Closing soon" },
  { value: "participated", label: "Most participated" },
] as const;

const STATUS_FILTERS = [
  { value: "all", label: "All polls" },
  { value: "active", label: "Live" },
  { value: "closed", label: "Closed" },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ExploreToolbarProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  statusFilter: "all" | "active" | "closed";
  onStatusChange: (value: "all" | "active" | "closed") => void;
  sortBy: "recent" | "closing" | "participated";
  onSortChange: (value: "recent" | "closing" | "participated") => void;
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
    <div className="flex flex-col gap-3 sm:flex-row">
      {/* ---- Search input ---- */}
      <div className="relative flex-1">
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

      {/* ---- Status filter pills ---- */}
      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((filter) => {
          const isActive = statusFilter === filter.value;
          return (
            <button
              key={filter.value}
              type="button"
              onClick={() => onStatusChange(filter.value)}
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

      {/* ---- Sort control ---- */}
      <div className="w-full sm:w-auto sm:min-w-[190px]">
        <Select
          options={[...SORT_OPTIONS]}
          value={sortBy}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            onSortChange(e.target.value as typeof sortBy)
          }
        />
      </div>
    </div>
  );
}
