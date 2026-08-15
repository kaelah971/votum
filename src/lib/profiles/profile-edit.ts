/**
 * V2B.1 profile-edit client logic (pure, testable units).
 *
 * The form never performs authorization or validation itself — the server
 * session is authoritative and PUT /api/profile/me re-validates everything.
 * These helpers only build the request payload, map responses to human copy,
 * and guard against duplicate submissions.
 */

import { normalizeHandle } from "./handles";
import type { ParticipantProfile } from "./types";

/**
 * The ONLY two editable fields. Built from raw form values; a wallet address
 * can never appear in the payload by construction.
 */
export interface EditPayload {
  displayName: string;
  handle: string;
}

/**
 * Build the PUT /api/profile/me body. Display name is trimmed (empty clears
 * to null server-side); handle is canonicalised to lowercase. The server
 * re-validates everything — this is payload shaping, not authorization.
 */
export function buildEditPayload(displayName: string, handle: string): EditPayload {
  return {
    displayName: displayName.trim(),
    handle: normalizeHandle(handle),
  };
}

/** Field-level error copy for the edit form. */
export interface EditFieldErrors {
  displayName?: string;
  handle?: string;
}

export type EditSaveResult =
  | { ok: true; profile: ParticipantProfile }
  | {
      ok: false;
      code:
        | "unauthorized"
        | "conflict_handle_taken"
        | "conflict_reserved"
        | "validation"
        | "network"
        | "server";
      fields: EditFieldErrors;
      message: string;
    };

export const HANDLE_TAKEN_COPY = "That handle was just taken. Try another one.";
export const HANDLE_RESERVED_COPY = "That handle is reserved.";
export const HANDLE_INVALID_COPY = "3\u201324 characters: letters, numbers, underscore.";
export const DISPLAY_NAME_INVALID_COPY = "Display name must be 1\u201340 characters.";

/**
 * Save the edit via PUT /api/profile/me and map every outcome to structured
 * human copy. Fields are never cleared by any failure path — the caller
 * preserves form values.
 */
export async function saveProfileEdit(
  payload: EditPayload,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<EditSaveResult> {
  let res: Response;
  try {
    res = await fetcher("/api/profile/me", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return {
      ok: false,
      code: "network",
      fields: {},
      message:
        "Votum could not reach the server. Your changes are still here — try again.",
    };
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (res.ok) {
    const profile = data.profile as ParticipantProfile | undefined;
    if (!profile) {
      return {
        ok: false,
        code: "server",
        fields: {},
        message:
          "Votum received an unexpected response. Your changes are still here — try again.",
      };
    }
    return { ok: true, profile };
  }

  const code = typeof data.error === "string" ? data.error : "";

  if (res.status === 401) {
    return {
      ok: false,
      code: "unauthorized",
      fields: {},
      message:
        "Your verified session has expired. Verify your wallet again to edit your profile.",
    };
  }
  if (res.status === 409 && code === "handle_taken") {
    return {
      ok: false,
      code: "conflict_handle_taken",
      fields: { handle: HANDLE_TAKEN_COPY },
      message: HANDLE_TAKEN_COPY,
    };
  }
  if (res.status === 409 && code === "reserved_handle") {
    return {
      ok: false,
      code: "conflict_reserved",
      fields: { handle: HANDLE_RESERVED_COPY },
      message: HANDLE_RESERVED_COPY,
    };
  }
  if (res.status === 400 && code === "invalid_handle") {
    return {
      ok: false,
      code: "validation",
      fields: { handle: HANDLE_INVALID_COPY },
      message: HANDLE_INVALID_COPY,
    };
  }
  if (res.status === 400 && code === "invalid_display_name") {
    return {
      ok: false,
      code: "validation",
      fields: { displayName: DISPLAY_NAME_INVALID_COPY },
      message: DISPLAY_NAME_INVALID_COPY,
    };
  }
  return {
    ok: false,
    code: "server",
    fields: {},
    message:
      "Votum could not save your profile. Your changes are still here — try again.",
  };
}

/** Prevents concurrent submissions — only one PUT can be in flight. */
export interface SaveGuard {
  begin: () => boolean;
  end: () => void;
  isBusy: () => boolean;
}

export function createSaveGuard(): SaveGuard {
  let busy = false;
  return {
    begin() {
      if (busy) return false;
      busy = true;
      return true;
    },
    end() {
      busy = false;
    },
    isBusy() {
      return busy;
    },
  };
}

/**
 * The wallet route is always canonical — a handle is only a friendly
 * resolver. The success view always links to /profile/[wallet].
 */
export function profileViewPath(walletAddress: string): string {
  return `/profile/${walletAddress}`;
}
