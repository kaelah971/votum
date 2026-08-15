/**
 * V2B.1 handle-availability tracker.
 *
 * Pure TypeScript (no React): coordinates debounced availability checks with
 * stale-response protection. Older responses can never overwrite newer input
 * state — every update() bumps a generation counter, aborts the in-flight
 * request, and results are applied only when their generation is current.
 *
 * The availability endpoint is advisory only (server re-validates on save);
 * `markTaken()` lets the form force the taken state when a save races and
 * loses (409 handle_taken) so no stale "Available" hint survives.
 */

import { isValidHandle, isReservedHandle, normalizeHandle } from "./handles";

export type HandleAvailabilityStatus =
  | "idle"        // empty input — nothing to check
  | "invalid"     // format rules not met — no request made
  | "reserved"    // reserved system handle — no request made
  | "unchanged"   // equals the user's current handle — no request made
  | "checking"    // debounce pending or request in flight
  | "available"
  | "taken"
  | "unknown";    // availability endpoint could not be reached

export interface HandleAvailability {
  /** Canonical normalized handle this state describes ("" when idle). */
  handle: string;
  status: HandleAvailabilityStatus;
}

export type AvailabilityFetcher = (
  handle: string,
  signal: AbortSignal,
) => Promise<{ available: boolean }>;

export interface HandleAvailabilityTrackerOptions {
  fetcher: AvailabilityFetcher;
  /** Quiet-typing window before an availability request fires. */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 400;

export class HandleAvailabilityTracker {
  private readonly fetcher: AvailabilityFetcher;
  private readonly debounceMs: number;
  private currentHandle: string | null = null;

  private state: HandleAvailability = { handle: "", status: "idle" };
  private listeners = new Set<(state: HandleAvailability) => void>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private inFlight: AbortController | null = null;

  constructor(options: HandleAvailabilityTrackerOptions) {
    this.fetcher = options.fetcher;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** The user's current (saved) handle — inputs equal to it show "unchanged". */
  setCurrentHandle(handle: string | null): void {
    this.currentHandle = handle;
  }

  /** Classify raw input without firing a request. */
  private classify(normalized: string): HandleAvailability["status"] {
    if (normalized.length === 0) return "idle";
    if (!isValidHandle(normalized)) return "invalid";
    if (isReservedHandle(normalized)) return "reserved";
    if (this.currentHandle === normalized) return "unchanged";
    return "checking";
  }

  /**
   * Call on every input change. Restarts the debounce window, cancels any
   * pending/in-flight check, and only the newest input can produce a result.
   */
  update(raw: string): void {
    this.generation += 1;
    this.clearDebounce();
    this.abortInFlight();

    const normalized = normalizeHandle(raw);
    const status = this.classify(normalized);

    if (status === "checking") {
      this.setState({ handle: normalized, status: "checking" });
      const generation = this.generation;
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        void this.runCheck(normalized, generation);
      }, this.debounceMs);
      return;
    }

    this.setState({ handle: normalized, status });
  }

  /**
   * Force the taken state for a handle (e.g. the save raced and lost with
   * 409 handle_taken). Cancels any pending/in-flight check so the stale
   * "Available" hint can never survive a lost race.
   */
  markTaken(raw: string): void {
    this.generation += 1;
    this.clearDebounce();
    this.abortInFlight();
    this.setState({ handle: normalizeHandle(raw), status: "taken" });
  }

  /** Stop all pending work. Safe to call from an unmount effect. */
  dispose(): void {
    this.generation += 1;
    this.clearDebounce();
    this.abortInFlight();
    this.listeners.clear();
  }

  getState(): HandleAvailability {
    return this.state;
  }

  /** Subscribe to state changes; immediately replays the current state. */
  subscribe(listener: (state: HandleAvailability) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async runCheck(handle: string, generation: number): Promise<void> {
    if (generation !== this.generation) return;

    const controller = new AbortController();
    this.inFlight = controller;

    try {
      const result = await this.fetcher(handle, controller.signal);
      if (generation !== this.generation) return; // stale — newer input won
      this.setState({
        handle,
        status: result.available ? "available" : "taken",
      });
    } catch {
      if (generation !== this.generation) return;
      this.setState({ handle, status: "unknown" });
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  private setState(next: HandleAvailability): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private abortInFlight(): void {
    if (this.inFlight !== null) {
      this.inFlight.abort();
      this.inFlight = null;
    }
  }
}
