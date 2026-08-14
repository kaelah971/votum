# V2B.1 Verified Participant Onboarding and Profiles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Votum's fragmented wallet-verification experience and introduce
the first participant identity layer: one shared onboarding surface
(Connect → Verify → profile created → return to the original action), one
public profile per verified wallet, canonical `/profile/[wallet]` and friendly
`/u/[handle]` routes, optional server-authoritative handles, and derived
public stats/activity — while preserving the existing signed-message
verification, sessions, votes, support, My Polls, and V2A Explore unchanged.

**Approved design:** `docs/superpowers/specs/2026-08-14-v2b1-verified-participant-onboarding-profiles-design.md`

**Architecture:** One additive `participant_profiles` table keyed by the
existing canonical-hex wallet identity anchor. The existing challenge →
explicit Nimiq Pay signature → atomic consume → `wallet_sessions` →
`votum_session` cookie flow is untouched. V2B.1 adds a session-gated
bootstrap endpoint, SECURITY DEFINER public-read RPCs (the established
`get_public_poll_results` pattern), an edit API with database-authoritative
handle claims, and a client onboarding controller that reuses
`VotumSessionProvider`/`verifyActiveWallet()` instead of introducing
competing auth state.

**Tech Stack:** Next.js 16.2.12, React 19.2.4, TypeScript, Supabase/Postgres,
Tailwind CSS v4, `npx tsx` script-based test suites (repo has no test runner).

---

## Global Constraints

- Verification cryptography, `wallet_sessions`, the `votum_session` cookie,
  and `getVerifiedWalletSession()` are **never modified**.
- No duplicate auth state: the onboarding controller consumes
  `NimiqProvider` + `VotumSessionProvider`; it does not re-implement session
  logic.
- `participant_profiles` is presentation/identity metadata only — never a
  source of voting or support truth.
- The selected vote choice (`poll_votes.option_id`, option labels) can never
  appear in any profile query, RPC, or response.
- Public boundary for all profile derivation:
  `is_public = true AND status IN ('live','closed')`.
- Handle uniqueness is database-authoritative (partial unique index).
- No N+1 queries: profile pages use one RPC per resolution; activity is
  bounded (limit 12); stats are index-served aggregates.
- Migration is strictly additive; backfill is `INSERT ... ON CONFLICT DO
  NOTHING`. Existing users never re-register.
- No rewards, no bio, no avatar, no followers/badges/reputation/streaks.
- V2A taxonomy/Explore files are untouched except for genuine V2B.1
  integration points (vote gate, create gate, wallet menu).
- No `supabase db push`, no `supabase link`, no `--linked`, no deploy, no
  merge to main. Hosted Supabase remains untouched.
- `next.config.ts` (LAN `allowedDevOrigins`) stays modified-but-unstaged.
- `scripts/seed-device-qa-fixtures.ts` is pre-existing untracked; never
  modify, stage, or delete it.
- Tests use the existing `npx tsx` + admin Supabase client +
  `cleanupTestWallet` pattern (see `src/lib/api/*-test.ts`).
- No placeholders or vague steps: every step names exact files and commands.

---

## Settled Technical Decisions

### D1. Migration `supabase/migrations/20260814000000_v2b1_participant_profiles.sql`

Next available number after `20260805000000_drop_obsolete_confirm_overload.sql`.
Strictly additive. Contents (locked in this plan; SQL written during Task 1):

- `CREATE TABLE public.participant_profiles`:
  - `wallet_address text PRIMARY KEY` — canonical hex (matches the value
    stored by the existing challenge/verify flow via `normalizeAddress`).
  - `display_name text NULL`
  - `handle text NULL`
  - `verified_at timestamptz NOT NULL DEFAULT now()`
  - `created_at timestamptz NOT NULL DEFAULT now()`
  - `updated_at timestamptz NOT NULL DEFAULT now()`
  - CHECKs: `display_name` trimmed length 1–40 and no newline;
    `handle ~ '^[a-z0-9_]{3,24}$'`.
- `CREATE UNIQUE INDEX participant_profiles_handle_uniq
  ON participant_profiles (handle) WHERE handle IS NOT NULL;`
- Additive indexes on existing tables (actual column names verified against
  the current schema):
  - `CREATE INDEX idx_poll_votes_voter_wallet
    ON poll_votes (voter_wallet, created_at DESC);`
  - `CREATE INDEX idx_nim_contributions_supporter
    ON nim_contributions (supporter_wallet);`
- RLS: `ENABLE ROW LEVEL SECURITY`, `REVOKE ALL ... FROM anon, authenticated`.
  Public reads flow through the RPCs below; writes through service_role admin
  client. (Matches `wallet_sessions`/`wallet_challenges` precedent.)
- No `set_updated_at` trigger — the repo has no such convention; the edit
  code sets `updated_at = now()` explicitly.
- One-time non-destructive backfill:
  `INSERT INTO participant_profiles (wallet_address) SELECT DISTINCT ... ON
  CONFLICT (wallet_address) DO NOTHING` over the union of wallets with public
  activity: `polls.creator_wallet` (public live/closed polls),
  `poll_votes.voter_wallet` joined to public polls, and
  `nim_contributions.supporter_wallet`. `verified_at` defaults to backfill
  time (documented approximation).
- Two SECURITY DEFINER read RPCs (`SET search_path = ''`, following the
  `get_public_poll_results`/`get_public_support_results` pattern), granted
  `EXECUTE` to `anon, authenticated, service_role`:
  - `get_participant_public_profile(_wallet text) RETURNS jsonb`
  - `get_participant_public_profile_by_handle(_handle text) RETURNS jsonb`
  - Both return the same shape (see D2); the wallet variant additionally
    canonicalizes/validates its input.
  - Stats via three index-served subselects; `nimEarnedLuna` is constant `0`
    (no reward ledger exists yet). Luna amounts returned as `text` to match
    `get_public_support_results` and avoid JS precision loss.
  - Activity via `UNION` of two public-only branches (`created` from `polls`,
    `participated` from `poll_votes` joined to public `polls`), ordered by
    event time, `LIMIT 12`. The SQL selects `polls.question` only — it never
    selects `poll_votes.option_id` and never joins `poll_options`.

### D2. Profile data contracts — `src/lib/profiles/types.ts` (new)

```ts
export interface ParticipantProfile {
  walletAddress: string;              // canonical hex
  displayName: string | null;
  handle: string | null;              // canonical lowercase
  verifiedAt: string;                 // ISO
  joinedDate: string;                 // ISO (created_at)
}

export interface ProfileStats {
  pollsCreated: number;
  participations: number;
  nimSupportedLuna: string;           // bigint as text, confirmed contributions only
  nimEarnedLuna: 0;                   // constant until reward ledger exists
}

export type ActivityKind = "created" | "participated";

export interface RecentActivityItem {
  kind: ActivityKind;
  pollId: string;
  question: string;                   // public poll title — the ONLY poll data exposed
  at: string;                         // ISO
}

export interface ParticipantPublicProfile {
  profile: ParticipantProfile | null; // null ⇒ wallet/handle unknown
  stats: ProfileStats;
  activity: RecentActivityItem[];
}
```

### D3. Handle rules — `src/lib/profiles/handles.ts` (new)

- `RESERVED_HANDLES: ReadonlySet<string>` — the approved spec's set
  (`admin`, `administrator`, `admins`, `votum`, `support`, `api`, `explore`,
  `profile`, `settings`, `login`, `logout`, `create`, `how-it-works`,
  `howitworks`, `my-polls`, `mypolls`, `drafts`, `insights`, `polls`,
  `poll`, `u`, `receipt`, `account`, `wallet`, `wallets`, `home`, `about`,
  `help`, `feedback`, `privacy`, `terms`, `faq`, `notifications`, `vote`,
  `votes`, `voting`, `signal`, `signals`, `nim`, `nimiq`, `verified`,
  `signup`, `signin`, `register`, `staff`, `team`, `system`, `root`, `mod`,
  `moderator`, `test`, `debug`, `example`, `user`, `users`).
- `normalizeHandle(raw: string): string` — `trim().toLowerCase()`.
- `isValidHandle(handle: string): boolean` — `/^[a-z0-9_]{3,24}$/`.
- `isReservedHandle(handle: string): boolean`.
- Server-authoritative: every edit endpoint re-validates; the partial unique
  index resolves all races (exactly one winner; losers get `handle_taken`).

### D4. Profile bootstrap — `src/lib/profiles/bootstrap.ts` (new) + `POST /api/profile/bootstrap` (new)

- `ensureParticipantProfile(wallet: string)` (server-only): admin client
  `INSERT ... ON CONFLICT (wallet_address) DO NOTHING`, then select and
  return the row. Idempotent; preserves existing display name/handle and the
  original `verified_at`.
- Route: `getVerifiedWalletSession()` first (401 `session_missing`); the
  wallet is taken **only** from the session — the request body contributes
  nothing. Returns the profile. No signature verification ⇒ no profile
  creation through onboarding.

### D5. Public profile reads — `src/lib/profiles/queries.ts` (new) + `GET /api/profile` (new)

- Query layer (server-only): `getPublicProfileByWallet(raw: string)` uses
  `normalizeAddress` (accepts NQ or hex) then the
  `get_participant_public_profile` RPC via the anonymous `createServerClient`
  (same key/pattern as `get_public_poll_results`); `getPublicProfileByHandle`
  uses the by-handle RPC. Returns `ParticipantPublicProfile`.
- Route: `GET /api/profile?wallet=...` or `?handle=...` → 200 with the
  allowlisted shape, 404 `profile_not_found` for unknown/malformed.
- Server-component pages call the query layer directly (no extra HTTP hop);
  the route exists for client components and tests.

### D6. Profile editing — `PUT /api/profile/me` (new) + `GET /api/profile/me/availability` (new)

- `PUT /api/profile/me` accepts `{ displayName?, handle? }`. Server enforces
  in order: session (401); ownership (session wallet only — body never
  supplies a wallet); display name trim/length/no-newline (empty string
  clears to `null`); handle `normalizeHandle` + `isValidHandle` (400
  `invalid_handle`) + `isReservedHandle` (409 `reserved_handle`); atomic
  claim via admin client:
  `update({ handle, updated_at: now() }).eq("wallet_address", session.address)
  .or(\`handle.is.null,handle.eq.${newHandle}\`)` with `count: "exact"`.
  Zero-row result or unique-violation (`code 23505`) ⇒ 409 `handle_taken`.
  Exactly one concurrent claim succeeds.
- `GET /api/profile/me/availability?handle=...` — validates format, checks
  reserved set, then `.eq("handle", ...)` select; returns
  `{ available: boolean }`. UX-only; never authoritative.
- Both routes are client-visible surfaces of server-only logic; no
  client-only authorization exists anywhere.

### D7. Onboarding controller — `src/lib/onboarding/return-path.ts`, `src/lib/onboarding/types.ts`, `src/providers/OnboardingProvider.tsx` (new)

- `OnboardingIntent = "generic_connect" | "vote" | "create_poll" | "profile"`.
- `OnboardingState = "disconnected" | "connecting" | "connected_unverified" |
  "verification_pending" | "verified" | "rejected_cancelled" | "expired" |
  "recoverable_failure"`.
- `isSafeInternalReturnPath(path: string): boolean` — must start with `/`;
  must not start with `//` or `/\`; must not contain `:` or `\`; must match a
  prefix in `["/", "/explore", "/create", "/how-it-works", "/polls/",
  "/my-polls", "/drafts", "/insights", "/profile", "/u/"]`. Anything else is
  rejected (caller falls back to `generic_connect`). Redirect is client-side
  `router.push` only.
- `OnboardingProvider` (mounted in `src/providers/ClientProviders.tsx`):
  - `openOnboarding({ intent, returnPath })`, `closeOnboarding()`.
  - Derives the 8-state machine from `useNimiqContext()` (walletStatus) and
    `useVotumSession()` (session status) — reuses `connectWallet()` and
    `verifyActiveWallet()`; adds **no** parallel session logic.
  - On transition to `verified`: calls `POST /api/profile/bootstrap` once
    (guarded by a ref so repeated state churn cannot double-fire), stores the
    returned profile, then resolves the intent: `profile` → `router.push(
    "/profile/" + wallet)`; `vote`/`create_poll`/`generic_connect` → stay on
    the page (the calling component resumes its flow from `isSessionVerified`).
  - Cancelled/denied signature → `rejected_cancelled` → user returns to
    `connected_unverified` (clean state). Expired/reused challenge →
    `expired` → "Start again" issues a fresh challenge. Network/server errors
    → `recoverable_failure` with retry that preserves the intent.
  - First-verification non-blocking message: "Your Votum profile is ready.
    Add a name or handle anytime." shown in the `verified` state only.

### D8. Onboarding surface — `src/components/onboarding/WalletOnboardingSheet.tsx` (new)

- Renders the 8 states; desktop modal / mobile bottom sheet following the
  existing overlay conventions (`ProductNav` drawer, `rounded-overlay`,
  `shadow-card`, `bg-clear-ballot`, `backdrop-blur`). Reuses `WalletButton`
  for connect, `Badge`, `Button`, existing `ErrorState`-style inline errors,
  and the repo's human copy — no raw stack traces.
- Mounted once in `ClientProviders` so it works on marketing and product
  pages alike.

### D9. Profile UI — components under `src/components/profile/` (new)

- `ProfileHeader` — display name or shortened-wallet fallback, `@handle`,
  `truncateAddress` wallet, `Badge variant="verified"` (exists today) with
  `VerifiedCheckIcon`, "Joined <date>".
- `ProfileStats` — four compact derived stats (Polls created, Participations,
  NIM supported, NIM earned = 0).
- `RecentActivity` — list of `Created "…"` / `Participated in "…"` items
  linking to `/polls/[pollId]`. Never renders a chosen option.
- `PublicProfileView` — assembles header, stats, activity for the two public
  routes.
- `ProfileEditForm` — display name + handle fields with live format
  validation, debounced availability feedback, server-error inline display,
  submit via `PUT /api/profile/me`; mobile keyboard-safe (no horizontal
  overflow, submit on Enter).

### D10. Routes

- `src/app/profile/[wallet]/page.tsx` (new, server component,
  `force-dynamic`) — `normalizeAddress(params.wallet)`; invalid → `notFound`.
  Fetches via query layer; unknown profile → `notFound`. `generateMetadata`
  from display name/handle. Renders `PublicProfileView`.
- `src/app/u/[handle]/page.tsx` (new) — `normalizeHandle`; invalid →
  `notFound`; resolves the same profile payload via the by-handle RPC.
- `src/app/profile/edit/page.tsx` (new, client) — owner-gated; renders
  `ProfileEditForm`; uses `WalletRequiredState` + `openOnboarding` when a
  verified session is missing or the wallet is unverified.

### D11. Integration points (minimal, V2B.1-only)

- `src/components/ui/WalletButton.tsx` — wallet menu gains: **View profile**
  (`/profile/[wallet]` when verified; otherwise triggers `openOnboarding(
  { intent: "profile" })`), **Edit profile** (`/profile/edit`), **My polls**
  (`/my-polls`), **Disconnect** (existing). Connected-but-unverified state
  shows a "Verify this wallet" CTA that triggers the sheet.
- `src/components/poll/PollVotingPanel.tsx` — the "Verify wallet ownership to
  vote." gate becomes `openOnboarding({ intent: "vote", returnPath:
  window.location.pathname })`.
- `src/app/create/page.tsx` — publish handler: when not
  `isSessionVerified`, open the sheet with `intent: "create_poll"` instead of
  letting the 401 surface raw; the user resumes by tapping Publish again.
- `src/app/my-polls/page.tsx` — unchanged (its existing verify gate remains
  valid; backward compatibility).
- `src/providers/ClientProviders.tsx` — mounts `OnboardingProvider` +
  `WalletOnboardingSheet`.

### D12. Test suites (repo convention: `npx tsx src/lib/api/<suite>-test.ts`)

- `src/lib/api/v2b1-onboarding-test.ts` — onboarding + return-path.
- `src/lib/api/v2b1-profile-test.ts` — profile + handle + bootstrap + edit.
- `src/lib/api/v2b1-privacy-test.ts` — privacy and public-shape contracts.
- `src/lib/api/v2b1-backward-test.ts` — backward-compatibility regression.

---

## Task Decomposition

### Task 1 — Additive migration: `participant_profiles`, indexes, RPCs, backfill

- [ ] Write `supabase/migrations/20260814000000_v2b1_participant_profiles.sql`
      per D1: table, CHECKs, partial unique handle index,
      `idx_poll_votes_voter_wallet`, `idx_nim_contributions_supporter`, RLS +
      revokes, backfill with `ON CONFLICT DO NOTHING`.
- [ ] Write the two SECURITY DEFINER RPCs (search_path `''`, anon-granted)
      per D1: profile row lookup, three stat subselects, `nimEarnedLuna = 0`,
      bounded public-only activity `UNION` selecting only `polls.question`.
- [ ] Apply the migration to the local Supabase instance only
      (`supabase db reset` is NOT used — apply via local CLI migration
      apply). Verify with a direct SQL check that the table, both indexes,
      and both functions exist.
- [ ] Run `npx tsx src/lib/api/v2b1-profile-test.ts` — RPC smoke checks fail
      (no test file yet — write the suite header in Task 2; for now confirm
      functions exist and return `not_found`/empty shapes via a direct admin
      client probe script committed under `src/lib/api/`).
- [ ] Run `npx tsc --noEmit` - 0 errors
- [ ] Commit: `feat(v2b1): add participant profiles migration`

### Task 2 — Profile data contracts and handle rules

- [ ] Write `src/lib/profiles/types.ts` per D2 (all interfaces).
- [ ] Write `src/lib/profiles/handles.ts` per D3
      (`RESERVED_HANDLES`, `normalizeHandle`, `isValidHandle`,
      `isReservedHandle`).
- [ ] Write failing tests in `src/lib/api/v2b1-profile-test.ts`
      (imports `./load-local-env`): reserved-set membership, format
      acceptance/rejection (3/24 boundaries, uppercase, spaces, symbols),
      lowercase canonicalisation.
- [ ] Run: `npx tsx src/lib/api/v2b1-profile-test.ts` — all pass
- [ ] Run: `npx tsc --noEmit` - 0 errors
- [ ] Run: `npm run lint` - 0 warnings
- [ ] Commit: `feat(v2b1): define profile contracts and handle rules`

### Task 3 — Session-gated profile bootstrap

- [ ] Write `src/lib/profiles/bootstrap.ts` with `ensureParticipantProfile`
      (admin client, `ON CONFLICT DO NOTHING`, returns row).
- [ ] Write `src/app/api/profile/bootstrap/route.ts` — session check (401
      `session_missing`), wallet from session only, bootstrap, return
      `ParticipantProfile`.
- [ ] Write failing tests (in `v2b1-profile-test.ts`): unauthenticated
      bootstrap → 401; bootstrap with a different wallet in the body still
      uses the session wallet; first bootstrap creates exactly one profile;
      second bootstrap is idempotent (same `verifiedAt`); display name and
      handle are preserved across repeats.
- [ ] Run: `npx tsx src/lib/api/v2b1-profile-test.ts` - all pass
- [ ] Run all prior v2b1 suites (Task 2 suite) unchanged
- [ ] Run: `npx tsc --noEmit`; `npm run lint` - clean
- [ ] Commit: `feat(v2b1): add session-gated profile bootstrap`

### Task 4 — Public profile query layer and API

- [ ] Write `src/lib/profiles/queries.ts` per D5 (anon client + the two RPCs;
      `normalizeAddress`/`normalizeHandle` input handling).
- [ ] Write `src/app/api/profile/route.ts` — `?wallet=` / `?handle=`; 200
      allowlisted shape; 404 `profile_not_found`; malformed input → 404.
- [ ] Write failing tests (in `v2b1-profile-test.ts`): known wallet via
      canonical hex and NQ format resolve identically; unknown wallet → 404;
      malformed wallet → 404; handle resolution returns the same
      `walletAddress`; unknown handle → 404; response contains **only** the
      allowlisted keys (deep-key assertion).
- [ ] Run: `npx tsx src/lib/api/v2b1-profile-test.ts` - all pass
- [ ] Run: `npx tsc --noEmit`; `npm run lint` - clean
- [ ] Commit: `feat(v2b1): add public profile query layer and API`

### Task 5 — Profile editing and handle claim API

- [ ] Write `src/app/api/profile/me/route.ts` implementing `PUT /api/profile/me`
      and `GET /api/profile/me` (owner fetch) per D6.
- [ ] Write `src/app/api/profile/me/availability/route.ts` per D6.
- [ ] Write failing tests (in `v2b1-profile-test.ts`): display-name set,
      update, clear-to-null; handle create; handle rename (old released);
      duplicate handle → 409 `handle_taken`; **concurrent race**: fire two
      parallel claims for one free handle — exactly one succeeds, the other
      gets 409; reserved handle → 409; malformed handle → 400; uppercase
      input stored lowercase; editing without a session → 401; editing
      another wallet's profile → 403.
- [ ] Run: `npx tsx src/lib/api/v2b1-profile-test.ts` - all pass
- [ ] Run all prior v2b1 suites unchanged
- [ ] Run: `npx tsc --noEmit`; `npm run lint` - clean
- [ ] Commit: `feat(v2b1): add profile editing and handle claim API`

### Task 6 — Onboarding controller and return-to-intent

- [ ] Write `src/lib/onboarding/types.ts` and
      `src/lib/onboarding/return-path.ts` per D7.
- [ ] Write `src/providers/OnboardingProvider.tsx` per D7 (state derivation,
      `verifyActiveWallet` reuse, one-shot bootstrap on verified, intent
      resolution, no parallel session logic).
- [ ] Mount provider + sheet in `src/providers/ClientProviders.tsx`.
- [ ] Write failing tests (in `v2b1-onboarding-test.ts`): return-path accepts
      `/polls/<id>`, `/create`, `/explore`; rejects `https://evil.com`,
      `//evil.com`, `/\evil.com`, `javascript:alert(1)`, `mailto:x`,
      backslash paths, non-prefix paths (`/evil`); onboarding maps provider
      statuses to the 8 states (pure state-derivation unit assertions).
- [ ] Run: `npx tsx src/lib/api/v2b1-onboarding-test.ts` - all pass
- [ ] Run: `npx tsc --noEmit`; `npm run lint` - clean
- [ ] Commit: `feat(v2b1): add onboarding controller and return-to-intent`

### Task 7 — Wallet onboarding sheet UI

- [ ] Write `src/components/onboarding/WalletOnboardingSheet.tsx` per D8
      (8 states, modal/bottom-sheet, `WalletButton` reuse, `Badge`/`Button`/
      existing tokens, human copy per design §13, no raw errors).
- [ ] Verified state shows the non-blocking "Your Votum profile is ready.
      Add a name or handle anytime." message.
- [ ] Add accessibility: labelled dialog (`role="dialog"`, `aria-modal`),
      Escape/backdrop close only in safe states, focus retained on trigger,
      `aria-busy` during pending states.
- [ ] Manual check in dev (`npm run dev`): connect → verify → sheet resolves
      → no redirect loop.
- [ ] Run: `npx tsc --noEmit`; `npm run lint` - clean
- [ ] Run all v2b1 suites unchanged
- [ ] Commit: `feat(v2b1): add wallet onboarding sheet`

### Task 8 — Wallet menu, vote gate, and create gate integration

- [ ] Modify `src/components/ui/WalletButton.tsx`: add **View profile** /
      **Edit profile** / **My polls** menu entries and the "Verify this
      wallet" CTA for connected-unverified; keep existing disconnect/session
      UI.
- [ ] Modify `src/components/poll/PollVotingPanel.tsx`: gate CTA opens the
      sheet with `intent: "vote"` and the current path as return path.
- [ ] Modify `src/app/create/page.tsx`: publish handler opens the sheet with
      `intent: "create_poll"` when unverified; no raw 401 surface.
- [ ] Manual check: after verifying from the vote gate, the poll page resumes
      (user can cast the vote); after create-publish verification, the create
      form is intact.
- [ ] Run: `npx tsc --noEmit`; `npm run lint` - clean
- [ ] Run all v2b1 suites unchanged
- [ ] Commit: `feat(v2b1): integrate onboarding entry points`

### Task 9 — Public profile pages

- [ ] Write `src/components/profile/ProfileHeader.tsx`, `ProfileStats.tsx`,
      `RecentActivity.tsx`, `PublicProfileView.tsx` per D9.
- [ ] Write `src/app/profile/[wallet]/page.tsx` and
      `src/app/u/[handle]/page.tsx` per D10 (server components, `notFound`
      paths, `generateMetadata`).
- [ ] Write failing contract tests (in `v2b1-profile-test.ts`): page-level
      data resolution for a created profile (header fields, joined date,
      stats values, activity items with `kind`/`question` only).
- [ ] Run: `npx tsx src/lib/api/v2b1-profile-test.ts` - all pass
- [ ] Run: `npx tsc --noEmit`; `npm run lint` - clean
- [ ] Commit: `feat(v2b1): add public profile pages`

### Task 10 — Profile edit page

- [ ] Write `src/app/profile/edit/page.tsx` + `ProfileEditForm` per D10
      (owner gate, live format validation, debounced availability, inline
      server errors, mobile keyboard-safe, Enter submits).
- [ ] Write failing tests (in `v2b1-profile-test.ts`): form validation rules
      mirror `handles.ts`; availability endpoint reflects taken/reserved/
      valid states; save flow maps 409/400 to inline copy.
- [ ] Run: `npx tsx src/lib/api/v2b1-profile-test.ts` - all pass
- [ ] Run: `npx tsc --noEmit`; `npm run lint` - clean
- [ ] Commit: `feat(v2b1): add profile edit page`

### Task 11 — Privacy and backward-compatibility hardening + full regression

- [ ] Write `src/lib/api/v2b1-privacy-test.ts`: public participation appears;
      poll title appears; **chosen option absent** (assert the RPC/API JSON
      contains no `option` key and no option label/id values); private/draft
      poll activity absent (create a private poll + vote, assert absence);
      no auth/session secrets in public profile responses (token, hash,
      session fields); NIM totals use confirmed records only (intent-only
      rows excluded); `nimEarnedLuna` is `0`.
- [ ] Write `src/lib/api/v2b1-backward-test.ts`: existing polls (public +
      private) still list; existing votes intact; one-wallet-one-vote and
      duplicate-vote rejection unchanged; My Polls flow intact; support
      intents → confirmed contributions unchanged; publish flow unchanged;
      existing verified wallets gain a profile via bootstrap without
      re-verification.
- [ ] Run: `npx tsx src/lib/api/v2b1-privacy-test.ts` - all pass
- [ ] Run: `npx tsx src/lib/api/v2b1-backward-test.ts` - all pass
- [ ] Run all V2A suites: `npx tsx src/lib/api/v2a2-test.ts` … `v2a7e-test.ts`,
      plus `node --env-file=.env.local --import tsx src/lib/api/vote-test.ts`
      and the support regression suite — unchanged results.
- [ ] Run all v2b1 suites; `npx tsc --noEmit`; `npm run lint`; `npm run build`
      - all clean
- [ ] Commit: `test(v2b1): verify privacy and backward compatibility`

### Task 12 — Device QA preparation and final regression

- [ ] Write `docs/superpowers/reviews/2026-08-14-v2b1-nimiq-pay-device-qa.md`
      with the checkpoint table (all rows `PENDING` — device results are
      recorded only after physical testing, never fabricated):
      landing-page Connect; Explore Connect; shared-poll Connect;
      Vote-triggered onboarding; explicit signature; return to poll/action;
      public profile route; handle editing; handle keyboard; mobile overflow;
      reconnect/session restore; wallet switch.
- [ ] Final regression: all v2b1 suites + all V2A suites + `npx tsc --noEmit`
      + `npm run lint` + `npm run build`.
- [ ] Verify working tree contains only expected exceptions:
      `next.config.ts` modified-unstaged; `scripts/seed-device-qa-fixtures.ts`
      untracked and untouched.
- [ ] Commit: `docs(v2b1): prepare device QA checklist and final regression`

---

## Rollout Boundary

All work stays on `feat/v2-participation-record` at/after
`d628994d3d7ee76201bd84ce7f0cfe702f7b444c`. The migration is applied to the
local Supabase instance only. During implementation do **not**: `supabase db
push`, `supabase link`, use `--linked`, deploy production, or merge main.
Hosted migration and production rollout remain a deliberate later gate. V2A
taxonomy/Explore work remains unshipped until that later gate.

## Completion Criteria

V2B.1 is complete when:

- Onboarding is one shared surface with all eight states, reachable from
  every intent trigger, returning to the user's action
- Verification never auto-signs; no duplicate auth implementation exists
- One profile per verified wallet; bootstrap is session-gated and idempotent;
  legacy verified users never re-register
- `/profile/[wallet]`, `/u/[handle]`, `/profile/edit` behave per spec
- Handle rules are server-authoritative with a DB-resolved claim race
- Stats and activity are derived, bounded, N+1-free, and public-boundary-only
- Vote choices never appear in any profile query or response
- All v2b1 suites pass; all V2A suites pass unchanged; tsc/lint/build clean
- Device QA checklist recorded from a real Nimiq Pay device session
- No hosted Supabase changes, no deploy, no merge to main
