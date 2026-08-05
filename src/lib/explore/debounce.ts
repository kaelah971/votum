/**
 * V2A.7D Debounced Search Controller
 *
 * Extracted from ExploreClient so the production debounce behaviour
 * can be tested deterministically without duplicating logic.
 */

export interface DebouncedSearch {
  /** Notify of a new input value.  Timer resets on each call. */
  notify: (value: string) => void;
  /** Cancel any pending timer.  No callback will fire. */
  cancel: () => void;
  /** Reset internal pending state (used by Clear filters / URL restore). */
  reset: () => void;
}

/**
 * Create a debounced search controller.
 *
 * @param onSearch  Called with the normalized (trimmed) value after debounce.
 * @param debounceMs  Milliseconds of inactivity before firing (default 300).
 */
export function createDebouncedSearch(
  onSearch: (value: string) => void,
  debounceMs = 300,
): DebouncedSearch {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;

  return {
    notify(value: string) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const trimmed = value.trim();
        if (trimmed !== pending) {
          pending = trimmed;
          onSearch(trimmed);
        }
      }, debounceMs);
    },

    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    reset() {
      pending = null;
    },
  };
}
