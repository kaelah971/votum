"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { CheckIcon } from "@/components/ui/icons";
import { useOnboarding } from "@/providers/OnboardingProvider";
import { normalizeDisplayName } from "@/lib/profiles/handles";
import {
  HandleAvailabilityTracker,
  type HandleAvailability,
  type HandleAvailabilityStatus,
} from "@/lib/profiles/handle-availability";
import {
  HANDLE_INVALID_COPY,
  buildEditPayload,
  createSaveGuard,
  profileViewPath,
  saveProfileEdit,
  type EditFieldErrors,
} from "@/lib/profiles/profile-edit";
import type { ParticipantProfile } from "@/lib/profiles/types";

interface ProfileEditFormProps {
  initialProfile: ParticipantProfile;
}

const HANDLE_DEBOUNCE_MS = 400;

/** Copy + tone for the live availability line (never color-only). */
const STATUS_COPY: Record<HandleAvailabilityStatus, string> = {
  idle: "Optional. 3\u201324 characters: letters, numbers, underscore.",
  invalid: HANDLE_INVALID_COPY,
  reserved: "That handle is reserved.",
  unchanged: "That\u2019s your current handle.",
  checking: "Checking availability\u2026",
  available: "Available \u2014 this one is free to claim.",
  taken: "That handle is already taken.",
  unknown: "Availability check failed. Saving will still re-check.",
};

const STATUS_TONE: Record<HandleAvailabilityStatus, string> = {
  idle: "text-quiet-ink",
  invalid: "text-fairness-amber",
  reserved: "text-fairness-amber",
  unchanged: "text-quiet-ink",
  checking: "text-quiet-ink",
  available: "text-verified-green",
  taken: "text-reject-red",
  unknown: "text-fairness-amber",
};

export function ProfileEditForm({ initialProfile }: ProfileEditFormProps) {
  const { openOnboarding } = useOnboarding();
  const pathname = usePathname();

  // Form values — preserved on every failure path.
  const [displayName, setDisplayName] = useState(initialProfile.displayName ?? "");
  const [handleInput, setHandleInput] = useState(initialProfile.handle ?? "");

  const [availability, setAvailability] = useState<HandleAvailability>({
    handle: "",
    status: "idle",
  });
  const [fieldErrors, setFieldErrors] = useState<EditFieldErrors>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "success">("idle");
  const [topMessage, setTopMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  const saveGuard = useRef(createSaveGuard()).current;

  // The tracker instance is stable for the form's lifetime.
  const [tracker] = useState(
    () =>
      new HandleAvailabilityTracker({
        debounceMs: HANDLE_DEBOUNCE_MS,
        fetcher: async (handle, signal) => {
          const res = await fetch(
            `/api/profile/me/availability?handle=${encodeURIComponent(handle)}`,
            { signal },
          );
          if (!res.ok) throw new Error("availability check failed");
          const data = (await res.json()) as { available?: boolean };
          return { available: data?.available === true };
        },
      }),
  );

  useEffect(() => tracker.subscribe(setAvailability), [tracker]);
  useEffect(() => () => tracker.dispose(), [tracker]);

  const handleDisplayNameChange = (e: ChangeEvent<HTMLInputElement>) => {
    setDisplayName(e.target.value);
    setSaveState("idle");
    setTopMessage(null);
    setFieldErrors((prev) => ({ ...prev, displayName: undefined }));
  };

  const handleHandleChange = (e: ChangeEvent<HTMLInputElement>) => {
    // Canonical lowercase as the user types — matches server storage.
    const value = e.target.value.toLowerCase();
    setHandleInput(value);
    setSaveState("idle");
    setTopMessage(null);
    setFieldErrors((prev) => ({ ...prev, handle: undefined }));
    tracker.update(value);
  };

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (saveState === "saving") return;
      if (!saveGuard.begin()) return;

      setSaveState("saving");
      setTopMessage(null);
      setFieldErrors({});

      // Block obviously-invalid display names client-side (server re-checks).
      const trimmedDisplayName = displayName.trim();
      if (trimmedDisplayName.length > 0 && normalizeDisplayName(displayName) === null) {
        setFieldErrors({ displayName: "Display name must be 1\u201340 characters." });
        setSaveState("idle");
        saveGuard.end();
        return;
      }

      const payload = buildEditPayload(displayName, handleInput);
      const result = await saveProfileEdit(payload);

      if (result.ok) {
        tracker.setCurrentHandle(result.profile.handle);
        setSaveState("success");
        setTopMessage({ tone: "success", text: "Profile updated." });
        // Re-classify the now-current handle so the hint says "unchanged".
        tracker.update(handleInput);
      } else {
        setSaveState("idle");
        setFieldErrors(result.fields);
        setTopMessage({ tone: "error", text: result.message });
        if (result.code === "conflict_handle_taken") {
          // Never leave a stale "Available" hint after losing the race.
          tracker.markTaken(handleInput);
        }
        if (result.code === "unauthorized") {
          openOnboarding({ intent: "generic_connect", returnPath: pathname });
        }
      }

      saveGuard.end();
    },
    [displayName, handleInput, saveState, tracker, openOnboarding, pathname, saveGuard],
  );

  const inputClasses =
    "w-full rounded-full border border-border bg-clear-ballot/72 px-4 py-3 text-sm " +
    "text-ballot-ink placeholder:text-micro-grey transition-colors " +
    "focus:border-signal-gold focus:outline-none focus:ring-1 focus:ring-signal-gold " +
    "disabled:opacity-50";

  const showCheck = availability.status === "available";

  return (
    <form
      onSubmit={handleSubmit}
      className="flex w-full flex-col gap-5"
      aria-busy={saveState === "saving"}
      noValidate
    >
      {/* Display name */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="edit-display-name" className="text-sm font-medium text-ballot-ink">
          Display name
        </label>
        <input
          id="edit-display-name"
          name="displayName"
          type="text"
          autoComplete="name"
          maxLength={40}
          placeholder="Your public name"
          value={displayName}
          onChange={handleDisplayNameChange}
          className={inputClasses}
          aria-invalid={fieldErrors.displayName ? "true" : undefined}
          aria-describedby={
            fieldErrors.displayName ? "edit-display-name-error" : "edit-display-name-hint"
          }
        />
        {fieldErrors.displayName ? (
          <p
            id="edit-display-name-error"
            role="alert"
            className="text-micro text-reject-red"
          >
            {fieldErrors.displayName}
          </p>
        ) : (
          <p id="edit-display-name-hint" className="text-micro text-quiet-ink">
            Optional. Shown on your public profile. Leave empty to remove it.
          </p>
        )}
      </div>

      {/* Handle */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="edit-handle" className="text-sm font-medium text-ballot-ink">
          Handle
        </label>
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm text-micro-grey"
          >
            @
          </span>
          <input
            id="edit-handle"
            name="handle"
            type="text"
            autoComplete="username"
            maxLength={24}
            placeholder="your_name"
            value={handleInput}
            onChange={handleHandleChange}
            className={`${inputClasses} pl-8`}
            aria-invalid={fieldErrors.handle ? "true" : undefined}
            aria-describedby={
              fieldErrors.handle
                ? "edit-handle-error edit-handle-status"
                : "edit-handle-status"
            }
          />
        </div>
        {fieldErrors.handle && (
          <p id="edit-handle-error" role="alert" className="text-micro text-reject-red">
            {fieldErrors.handle}
          </p>
        )}
        <p
          id="edit-handle-status"
          role="status"
          className={`flex items-center gap-1 text-micro ${STATUS_TONE[availability.status]}`}
        >
          {showCheck && <CheckIcon className="h-3 w-3" />}
          {availability.handle ? `@${availability.handle} \u2014 ${STATUS_COPY[availability.status]}` : STATUS_COPY[availability.status]}
        </p>
      </div>

      {/* Top-level feedback */}
      {topMessage && (
        <p
          role={topMessage.tone === "error" ? "alert" : "status"}
          className={`text-body ${topMessage.tone === "error" ? "text-reject-red" : "text-verified-green"}`}
        >
          {topMessage.text}
        </p>
      )}

      {/* Save + success actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button
          type="submit"
          variant="primary"
          size="md"
          className="w-full sm:w-auto"
          disabled={saveState === "saving"}
        >
          {saveState === "saving" ? (
            <>
              <Spinner className="mr-2" />
              {"Saving\u2026"}
            </>
          ) : (
            "Save changes"
          )}
        </Button>
        {saveState === "success" && (
          <Link
            href={profileViewPath(initialProfile.walletAddress)}
            className="text-sm font-medium text-nim-blue hover:text-signal-gold transition-colors focus-visible:outline-none focus-visible:underline"
          >
            {"View profile \u2192"}
          </Link>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Small inline loading spinner (mirrors the WalletButton pattern).
// ---------------------------------------------------------------------------
function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="28"
        strokeDashoffset="8"
        strokeLinecap="round"
        opacity="0.4"
      />
    </svg>
  );
}
