# V2B.1 — Verified Participant Onboarding and Public Profiles

**Status:** Approved (design only)
**Date:** 2026-08-14
**Branch:** `feat/v2-participation-record`
**Starting HEAD:** `cb3ade4`
**Depends on:** V2A.7 (Explore), the existing wallet-proof verification flow
**Scope:** Design spec only — no implementation, no migration, no deployment in this step.

---

## Purpose

Fix Votum's fragmented wallet-verification experience and introduce the first
real participant identity layer.

Current UX:

```
Connect wallet
→ user later discovers My Polls
→ verifies wallet there
```

New UX:

```
Connect wallet
→ verify ownership immediately
→ public Votum profile created/loaded
→ return to the action the user was performing
```

No page hunting. No forced signup form. No mandatory profile-completion wizard.

V2B.1 is the identity foundation for later V2B rewarded participation. It does
**not** implement rewards.

---

## Current Architecture (as of `cb3ade4`)

### Identity model today

There is **no `users` or `profiles` table**. The PRD's original sketch of a
`users`/`wallet_address` identity table was never built. Identity today is a
plain `text` wallet column spread across every activity table:

| Table | Identity column | Constraints / indexes |
|-------|----------------|-----------------------|
| `polls` | `creator_wallet` (text NOT NULL) | `idx_polls_creator_wallet (creator_wallet, created_at DESC)` |
| `poll_votes` | `voter_wallet` (text NOT NULL) | `UNIQUE (poll_id, voter_wallet)`; `idx_poll_votes_poll`, `idx_poll_votes_option` |
| `nim_support_intents` | `supporter_wallet`, `initiator_wallet` (text NOT NULL) | `idx_nim_intents_supporter` |
| `nim_contributions` | `supporter_wallet` (text NOT NULL) | `idx_nim_contributions_poll`, `idx_nim_contributions_option` — **no supporter index** |
| `wallet_challenges` | `wallet_address` (text NOT NULL) | `idx_wallet_challenges_wallet`, `idx_wallet_challenges_unused` |
| `wallet_sessions` | `wallet_address` (text NOT NULL) | `idx_wallet_sessions_wallet` |

Wallet addresses are stored in canonical hex form (normalised server-side by
`normalizeAddress` in `src/lib/nimiq/server-crypto.ts`). No format CHECK exists
on any wallet column.

### Wallet verification flow today (proven, to be preserved)

```
POST /api/wallet-proof/challenge
  same-origin check → normalizeAddress → 5-minute single-use challenge
  (message embeds domain, address, nonce, issue/expiry timestamps)
  dangling unused challenges for the wallet are marked used first

POST /api/wallet-proof/verify
  same-origin → challenge exists / not expired / not used
  → submitted address canonicalizes and equals challenge.wallet_address
  → signer derived from public key equals challenge.wallet_address
  → Nimiq MiniApp signature over challenge message verifies
  → challenge atomically consumed (guarded UPDATE)
  → wallet_sessions row (sha256 token hash, 12h TTL)
  → httpOnly sameSite=lax `votum_session` cookie (12h)

GET  /api/wallet-proof/session   → { verified, walletAddress }
POST /api/wallet-proof/logout    → revokes session, clears cookie
```

Server-side session read: `getVerifiedWalletSession()` (`src/lib/api/session.ts`)
reads the cookie, hashes the token, and validates against `wallet_sessions`
(revoked/expired → null). It is the gate for `POST /api/polls/[pollId]/vote`
(401 `session_missing`), `POST /api/polls/publish` (401), and the support
routes.

Client-side session machine: `VotumSessionProvider` exposes statuses
`loading / unverified / verified_no_wallet / verified_wallet_mismatch /
requesting_challenge / awaiting_signature / verifying / verified /
permission_denied / expired / error` and `verifyActiveWallet()` (challenge →
explicit `signMessage` in Nimiq Pay → verify). `verifyActiveWallet` is the
single explicit-signing path — **Votum never auto-signs**.

### Where verification is surfaced today

- `src/app/my-polls/page.tsx` — the only page with a "Verify wallet ownership"
  gate. This is the fragmented experience V2B.1 replaces.
- `src/components/poll/PollVotingPanel.tsx` — vote gate text "Verify wallet
  ownership to vote." (no onboarding surface; user must find the wallet menu).
- `src/components/ui/WalletButton.tsx` — connect / account menu / session
  status; no profile entries yet.

### Public-data boundary (privacy ground truth)

Public polls are exactly `is_public = true AND status IN ('live','closed')`.
This is enforced by RLS policies (`polls_public_read`, `poll_options_public_read`)
and by every public query (`public-polls.ts`, `explore-queries.ts`) and by the
public results RPC (`get_public_poll_results`). Drafts and private polls are
never public. V2B.1 derives public profile data from this same boundary.

---

## Product Decisions (Final)

- One shared onboarding surface (modal on desktop, bottom sheet on mobile)
  handles **all** wallet connect + verify flows across the app.
- Verification stays an explicit user action. **No silent auto-signing.**
- A connected wallet is **not** automatically verified.
- Every successfully verified wallet gets exactly **one** participant profile.
- Profile creation happens **only** after successful cryptographic ownership
  verification, and only from the server-side session wallet.
- Profiles are **public by default** for V2B.1.
- Canonical identity route: `/profile/[wallet]`. Friendly optional route:
  `/u/[handle]`. Edit surface: `/profile/edit`.
- Onboarding never dumps the user into My Polls; it returns to the intent.
- Return targets must be validated internal routes (no open redirect).
- Handle is optional, canonical-lowercase, globally unique, database-authoritative.
- Stats are derived from authoritative tables; never stored on the profile.
- Recent public activity shows poll titles only — **never the selected choice**.
- The verified Nimiq wallet is the immutable identity anchor; changing display
  name or handle never changes identity.
- Existing verified users gain profiles automatically — no re-registration.
- Existing verification cryptography, sessions, votes, support, My Polls, and
  V2A Explore are untouched.

---

## 1. Onboarding Architecture

### 1.1 One shared surface

A single onboarding surface (`WalletOnboardingSheet`), used everywhere a wallet
action is required:

| Trigger | Intent |
|---------|--------|
| Wallet button "Connect wallet" | `generic_connect` |
| Vote gate (`PollVotingPanel`) | `vote` |
| Publish gate (`Create`) | `create_poll` |
| Account menu "Verify this wallet" | `generic_connect` |
| Any verified-action 401 | caller-supplied intent |
| Explicit profile open | `profile` |

The surface is triggered with `openOnboarding({ intent, returnPath })`. It
embeds the existing `WalletButton` connect semantics and the existing
`verifyActiveWallet()` flow — no parallel auth path is introduced.

### 1.2 State machine

The surface renders one of eight states:

| # | State | Condition / transition |
|---|-------|------------------------|
| 1 | **Disconnected** | No wallet connected. CTA: "Connect wallet". On connect → 2. |
| 2 | **Connecting** | `walletStatus === "connecting"`. On success → 3; on denial → 1 with permission copy. |
| 3 | **Connected but unverified** | Wallet connected, no matching verified session. CTA: "Verify wallet ownership" (explicit). On tap → 4. |
| 4 | **Verification pending** | `requesting_challenge` / `awaiting_signature` / `verifying` (user is signing in Nimiq Pay). |
| 5 | **Verified** | Session verified + profile loaded. Transient success; then resolve intent. |
| 6 | **Rejected / cancelled** | Signature denied or Nimiq Pay dismissed. Returns to 3 (clean connected-unverified state). |
| 7 | **Expired** | Challenge expired server-side (or reused). Fresh challenge offered; returns to 4. |
| 8 | **Recoverable failure** | Network / server failure. Retry keeps intent; back returns to 3. |

Session-restore nuance: if a verified session already exists for the connected
wallet, the surface skips straight to 5 and resolves the intent.

Wallet switched midway (active wallet changes during 4): abort the pending
signature, return to 3, and show "Wallet changed — verify the selected wallet."

### 1.3 Happy path

```
Connect wallet
→ wallet available
→ explicitly Verify ownership
→ request fresh signed-message challenge
→ user signs in Nimiq Pay
→ server verifies signature
→ session established
→ profile upserted (bootstrap)
→ success
→ return to original action
```

Signing is always an explicit Nimiq Pay action.

---

## 2. Return-to-Intent

The onboarding trigger always records *why* verification was required.

| Intent | Return behaviour |
|--------|------------------|
| `vote` | Resume the pending vote flow on the same poll page. |
| `create_poll` | Resume the creation flow. |
| `profile` | Open the user's public profile. |
| `generic_connect` | Stay on the current page (open the wallet menu / show verified state). |

The user is **never** dumped into My Polls simply because authentication was
required.

### Return-target validation

`returnPath` (defaults to current `pathname`) must pass
`isSafeInternalReturnPath()`:

- must be a string starting with `/`;
- must not start with `//` (protocol-relative) or `/\`;
- must not contain `:` or `\\` anywhere (blocks schemes and Windows paths);
- must match one of the internal route prefixes:
  `/`, `/explore`, `/create`, `/how-it-works`, `/polls/`, `/my-polls`,
  `/drafts`, `/insights`, `/profile`, `/u/`.

Anything else falls back to `generic_connect` behaviour (stay on page). The
redirect is executed client-side with `router.push`. This is defense-in-depth;
no user-supplied URL is ever fetched or followed server-side.

---

## 3. Identity Model

- Every successfully verified wallet gets exactly one Votum participant
  profile.
- The verified Nimiq wallet is the immutable identity anchor.
- A connected wallet is **not** automatically verified.
- Profile creation occurs only after successful cryptographic wallet ownership
  verification (the existing challenge/signature flow).
- Repeated verification of the same wallet loads/updates the same profile,
  never another account (idempotent upsert, PK = wallet address).
- Switching wallets requires ownership verification of the new wallet.
  Existing sessions for other wallets remain valid for their own wallet.
- Disconnecting does **not** delete the profile.
- Existing verified users become valid profiles automatically (bootstrap on
  next verify + one-time non-destructive backfill).

---

## 4. Data Model Review and Proposal

### 4.1 Discovered identity/schema facts

- No identity table exists; identity is the canonical-hex wallet column on
  `polls`, `poll_votes`, `nim_support_intents`, `nim_contributions`,
  `wallet_challenges`, `wallet_sessions` (see Current Architecture).
- `wallet_sessions` is the de-facto "verified user" record, but it is
  ephemeral (12h TTL, multiple rows per wallet) and RLS-revoked — not a
  suitable anchor for a public profile.
- Wallet columns are `text NOT NULL`, no format CHECKs, no uniqueness across
  tables.
- `polls` already carries `idx_polls_creator_wallet (creator_wallet, created_at DESC)`.
- `nim_contributions` has **no** `supporter_wallet` index.
- `poll_votes` has **no** `voter_wallet`-leading index for profile queries.

### 4.2 Decision: extend, do not duplicate

There is no single user record to extend, so V2B.1 adds **one** additive
identity table keyed by the existing identity anchor. This is the minimal
extension of the existing "verified wallet" concept:

```
participant_profiles
  wallet_address  text PRIMARY KEY          -- canonical hex; immutable identity anchor
  display_name    text                      -- optional, editable
  handle          text                      -- optional, editable, unique
  verified_at     timestamptz NOT NULL      -- first successful ownership verification
  created_at      timestamptz NOT NULL      -- joined date (display "Joined <date>")
  updated_at      timestamptz NOT NULL

  CHECK (display_name IS NULL OR char_length(trim(display_name)) BETWEEN 1 AND 40)
  CHECK (display_name IS NULL OR position(E'\n' IN display_name) = 0)
  CHECK (handle IS NULL OR handle ~ '^[a-z0-9_]{3,24}$')
```

Uniqueness / indexes:

```
CREATE UNIQUE INDEX participant_profiles_handle_uniq
  ON participant_profiles (handle) WHERE handle IS NOT NULL;   -- authoritative handle claim
CREATE INDEX nim_contributions_supporter ON nim_contributions (supporter_wallet);
CREATE INDEX poll_votes_voter_wallet     ON poll_votes (voter_wallet, created_at DESC);
```

`joined date` is `created_at` — no duplicated column. `verified_at` is set at
first verification and preserved by idempotent bootstrap.

### 4.3 RLS / access

`participant_profiles` follows the existing private-table pattern: RLS
enabled, all access revoked from `anon, authenticated`, service_role only.
Public reads go through SECURITY DEFINER read functions (see §8), exactly like
`get_public_poll_results` and `get_public_support_results`. The profile API
routes use the admin client for writes and the public functions for reads.

### 4.4 Migration required — **YES**

Reasons:

1. A new table is needed (no identity table exists to extend in place).
2. Two additive indexes on existing tables are needed for non-N+1 stats.
3. One-time non-destructive backfill is needed so existing verified users are
   immediately discoverable.
4. Two SECURITY DEFINER read functions + grants are needed for the public
   profile read path.

The migration (written in the implementation step, **not here**) is strictly
additive: `CREATE TABLE`, `CREATE INDEX`, `CREATE FUNCTION`, `INSERT ...
SELECT DISTINCT ... ON CONFLICT DO NOTHING`, `GRANT`. It never ALTERs existing
rows, never drops, never rewrites. Backfill source: distinct wallets with any
**public** activity (public `polls.creator_wallet`, `poll_votes.voter_wallet`
joined to public polls, confirmed `nim_contributions.supporter_wallet`).
Backfilled `verified_at` is the backfill time — documented approximation,
since these wallets demonstrably completed the same signed challenge flow to
vote/publish, but the exact first-verification timestamp is not recoverable.

Rollout rule: this migration lives on the feature branch only. **No
`supabase db push`, no link, no hosted Supabase changes in this design step or
the implementation step.**

---

## 5. Public Profile Model

Public by default for V2B.1. Launch fields:

| Field | Source | Editable |
|-------|--------|----------|
| `walletAddress` | `participant_profiles.wallet_address` (canonical hex; displayed as `NQ…xxxx` via existing `truncateAddress`) | never |
| `displayName` | `display_name` | owner only |
| `handle` | `handle` (canonical lowercase) | owner only |
| `verifiedStatus` | presence of profile + `verified_at` | never |
| `verifiedAt` | `verified_at` | never |
| `joinedDate` | `created_at` | never |
| `createdAt` / `updatedAt` | timestamps | never |

Explicitly **not** added: bio, avatar upload, followers/following, badges,
reputation score, participation score, streak system. All deferred.

---

## 6. Profile Routes

| Route | Behaviour |
|-------|-----------|
| `/profile/[wallet]` | **Canonical.** Always works for a valid profile. Server validates/normalises the wallet segment (invalid → `notFound`); resolves via wallet. |
| `/u/[handle]` | **Friendly, optional.** Resolves handle → same profile; renders the same public profile component. Handle changes never break the canonical route. |
| `/profile/edit` | Owner-only. Renders profile editing for display name + handle; guarded by verified session matching the profile wallet. |

`/u/[handle]` resolution: server looks up handle (canonical lowercase), then
serves the same profile payload as the wallet route. No redirect gymnastics
required in V2B.1.

Old-handle redirects: **not required in V2B.1.** The wallet route is canonical,
handles are brand-new (no pre-existing handles to orphan), and there is no
trivial safe redirect table yet. Deferred until handle churn exists.

---

## 7. Handle Rules

- Optional. When absent, the profile identifies by shortened wallet.
- Canonical lowercase: stored and matched lowercase (the client lowercases
  input; the DB CHECK enforces `[a-z0-9_]`).
- 3–24 characters, ASCII letters, digits, underscore only.
- Globally unique. **Database uniqueness is authoritative** via the partial
  unique index — the client availability check is UX only.
- Reserved handles blocked server-side (authoritative constant, validated in
  the edit API), expanded from current routes and system terminology:

  `admin`, `administrator`, `admins`, `votum`, `support`, `api`, `explore`,
  `profile`, `settings`, `login`, `logout`, `create`, `how-it-works`,
  `howitworks`, `my-polls`, `mypolls`, `drafts`, `insights`, `polls`, `poll`,
  `u`, `receipt`, `account`, `wallet`, `wallets`, `home`, `about`, `help`,
  `feedback`, `privacy`, `terms`, `faq`, `notifications`, `vote`, `votes`,
  `voting`, `signal`, `signals`, `nim`, `nimiq`, `verified`, `signup`,
  `signin`, `register`, `staff`, `team`, `system`, `root`, `mod`, `moderator`,
  `test`, `debug`, `example`, `user`, `users`

  (Equivalent lowercase-normalised set; case-insensitive comparison on the
  lowercased input.)

- Concurrent claims of the same free handle → exactly one winner: the atomic
  `UPDATE ... SET handle = _new WHERE wallet_address = _me AND (handle IS NULL
  OR handle = _new)` guarded by the unique index. The second request receives
  `handle_taken` (unique-violation or zero-row update).
- Changing a handle does **not** change identity.
- Reserved/handle-format rules are re-validated server-side on every edit; the
  client check is cosmetic.

---

## 8. Public Profile Content

### Header

```
Kaelah            ← display name (when configured)
@kaelah           ← handle (when configured)
NQ12…8K4P · Verified
Joined Jan 2026
```

If no display name: the shortened wallet (`NQ12…8K4P`) becomes the identity
line, and `Verified` is always present (profile existence implies verified
ownership). No display name → no fake-name fallback.

### Stats (derived — never persisted on the profile)

| Stat | Authoritative source | Query |
|------|---------------------|-------|
| Polls created | `polls` | count where `creator_wallet = _w AND is_public AND status IN ('live','closed')` |
| Participations | `poll_votes` | count where `voter_wallet = _w` joined to public polls (same boundary) |
| NIM supported | `nim_contributions` (confirmed only) | `sum(amount_luna)` where `supporter_wallet = _w` |
| NIM earned | — | constant `0` until the V2B reward ledger exists; never a column |

Users can never edit these totals. NIM earned displays `0` with the honest
note that reward settlement arrives in a later release.

### Derived-stats RPC

One SECURITY DEFINER function, `get_participant_profile_stats(_wallet)`
returns jsonb with the four counters. All four are index-served aggregates —
the query never loads voting/support history into the app, only `sum`/`count`
results. `nim_contributions.supporter_wallet` and
`poll_votes(voter_wallet, created_at DESC)` indexes (proposed §4.2) make each
count an index scan. Grant `EXECUTE` to `anon, authenticated, service_role`
(follows `get_public_poll_results` precedent).

---

## 9. Recent Public Activity and Vote-Choice Privacy

### 9.1 Derivation

A second SECURITY DEFINER function, `get_participant_recent_activity(_wallet)`,
merges two public-only sources ordered by event time, limit 12:

```
created:
  SELECT 'created' AS kind, p.id AS poll_id, p.question, p.created_at AS ts
  FROM polls p WHERE p.creator_wallet = _w
    AND p.is_public AND p.status IN ('live','closed')

participated:
  SELECT 'participated' AS kind, p.id AS poll_id, p.question, v.created_at AS ts
  FROM poll_votes v JOIN polls p ON p.id = v.poll_id
  WHERE v.voter_wallet = _w
    AND p.is_public AND p.status IN ('live','closed')
```

The **poll title may be displayed** — it is already public on the poll's own
page. Poll titles are returned by the same join (no N+1 title lookups).

No generic activity-feed table is created: repository inspection confirms
these two sources are sufficient and authoritative for V2B.1.

### 9.2 Privacy rule (critical)

**Public identity ≠ public vote choice.**

- Allowed: `Participated in "Which feature should we build next?"`
- **Forbidden: `Voted for "Mobile App"`** — the selected option must never
  appear.

Enforcement is server-side by construction: the activity SQL selects only
`polls.question`; `poll_votes.option_id` is never selected, never joined to
option labels, and absent from the function's return shape. The public profile
API contract (§12) is an allowlist that cannot carry option data.

Private polls, drafts, and other non-public records never appear: both
branches filter `is_public = true AND status IN ('live','closed')` — the exact
V2A public boundary.

### 9.3 Voting privacy principle

V2B.1 establishes: profiles may show that a wallet participated in a public
poll, but never which option was chosen. Future poll types that expose public
choices would require explicit disclosure **before** participation and are
outside V2B.1 — not pre-built now.

---

## 10. Profile Editing UX

- Supports only **display name** and **handle**.
- No mandatory editing step during onboarding. After first successful
  verification, show only a lightweight, non-blocking message:

  > "Your Votum profile is ready. Add a name or handle anytime."

  The user immediately continues their intended action.
- From the wallet/account menu, add entries (following the existing dropdown
  pattern in `WalletButton`):

  - View profile
  - Edit profile
  - My polls (existing link target, new entry)
  - Disconnect (existing)

- Follow current Votum visual language (`DESIGN.md`). No product redesign.

---

## 11. Session / Verification Security

Preserve the existing signed-message mechanism exactly; it is already correct
(single-use, TTL 5 min, replay-rejected, origin-checked, address-derived
signer, atomic consume, hashed session tokens). V2B.1 only **adds** profile
operations behind it:

| Requirement | Mechanism |
|-------------|-----------|
| Challenge short-lived | existing 5-minute TTL |
| Challenge single-use | existing atomic consume |
| Fresh challenge after expiry | existing flow; sheet offers "Start again" |
| Replay rejected | existing `used_at` + guarded update (409) |
| Invalid signature rejected | existing verification (400) |
| Arbitrary wallet cannot create a profile | bootstrap endpoint is session-gated; wallet comes from the server session, never from the request body |
| Profile belongs to verified session wallet | bootstrap/edit derive `wallet_address` from `getVerifiedWalletSession()` only |
| Wallet switching | verified session for wallet A stays valid for A; new wallet requires its own verify; sheet shows mismatch state |
| Cancelled signing leaves clean connected/unverified state | sheet state 6 returns to state 3; no partial session, no partial profile |
| Verification errors do not corrupt previous profile/session | profile writes are independent idempotent upserts keyed by wallet; a failed bootstrap for wallet B never touches wallet A's profile or session |
| Sensitive auth/session data never in public profile APIs | public profile responses return only the allowlisted fields; tokens, hashes, session rows are never selected |

---

## 12. API / Server Boundary

### Operations

| Operation | Endpoint / function | Authz |
|-----------|---------------------|-------|
| Verify wallet + bootstrap profile | existing `POST /api/wallet-proof/verify` (unchanged) **plus** `POST /api/profile/bootstrap` | verify: challenge flow; bootstrap: verified session only |
| Fetch public profile by wallet | `GET /api/profile?wallet=` (server component path `/profile/[wallet]`) | public |
| Resolve profile by handle | `GET /api/profile?handle=` (server component path `/u/[handle]`) | public |
| Edit own profile | `PUT /api/profile/me` | verified session; `wallet_address` from session only |
| Derive stats | RPC `get_participant_profile_stats` | public read (SECURITY DEFINER) |
| Derive recent activity | RPC `get_participant_recent_activity` | public read (SECURITY DEFINER) |

### Bootstrap semantics

`POST /api/profile/bootstrap`:

1. `getVerifiedWalletSession()` → 401 `session_missing` if absent (an
   unauthenticated caller cannot create a profile — covers the
   "unauthorized/direct profile bootstrap" test).
2. `wallet_address = session.address` (request body contributes nothing).
3. Idempotent upsert: `INSERT ... ON CONFLICT (wallet_address) DO NOTHING`
   (existing profile untouched: first `verified_at` preserved, display name
   and handle preserved).
4. Returns the profile. Client marks onboarding state 5 and resolves intent.

### Edit semantics

`PUT /api/profile/me` accepts `{ displayName?, handle? }`. Server enforces,
in order: session; ownership (session wallet === profile wallet); display name
trim/length/control-char rules; handle lowercase + format `^[a-z0-9_]{3,24}$`;
reserved-handle set; atomic claim update with unique-index guarantee; returns
`handle_taken` (409) on conflict. No client-only authorization anywhere.

### Public profile response (allowlist)

```
{ walletAddress, displayName, handle, verifiedAt, joinedDate,
  stats: { pollsCreated, participations, nimSupportedLuna, nimEarnedLuna },
  activity: [{ kind: 'created'|'participated', pollId, question, at }] }
```

Anything else — session data, tokens, option ids/labels, non-public records —
cannot be represented by this shape.

---

## 13. Failure UX

Graceful, human copy. No raw stack traces or internal error text. Existing
`ErrorState`/inline-error patterns are reused.

### Wallet verification

| Failure | UX |
|---------|----|
| Signature rejected (denied in Nimiq Pay) | Sheet state 6: "Verification cancelled. Nothing was signed." → back to state 3 |
| Cancelled (dismissed) | Same as rejected; clean connected-unverified state |
| Expired challenge | Sheet state 7: "This verification expired. Try again." → fresh challenge |
| Invalid signature | "The wallet signature could not be verified. Try again." |
| Reused challenge | Same as expired ("Start again") |
| Network failure | State 8: retry keeps intent; back returns to 3 |
| Server failure | State 8 with staged message and request ref; retry |
| Wallet switched midway | "Wallet changed — verify the selected wallet." → state 3 |

### Profiles

| Failure | UX |
|---------|----|
| Unknown wallet profile | `notFound` page ("No Votum profile for this wallet yet") |
| Malformed wallet route | `notFound` (invalid address segment) |
| Handle not found | `notFound` ("No profile found for @handle") |
| Handle already taken | Inline error on edit form: "That handle is already taken." |
| Reserved handle | Inline: "That handle is reserved." |
| Invalid handle | Inline: "3–24 characters: letters, numbers, underscore." |
| Concurrent handle claim | Same inline "already taken" (server winner wins) |
| Profile query failure | `ErrorState` with retry |

---

## 14. Performance / Query Strategy

- One profile page = 1–2 server queries total: profile row (+ by-handle
  resolution when needed) and the two SECURITY DEFINER RPCs (stats + activity).
- No N+1: poll titles arrive joined inside the activity RPC; stats are
  `count`/`sum` aggregates only.
- Never load full voting/support history for the four counters.
- Index plan (from §4.2): `polls (creator_wallet, created_at DESC)` exists;
  add `nim_contributions (supporter_wallet)`, `poll_votes (voter_wallet,
  created_at DESC)`, and the handle partial unique index.
- Activity is bounded (limit 12) and merges two ordered index scans.
- Page payload is small and static-friendly; profile pages stay fast inside
  the Nimiq Pay WebView.

---

## 15. Mobile / Nimiq Pay UX

The onboarding sheet is bottom-sheet on mobile (following existing overlay
patterns in `ProductNav`/notifications). Device QA must cover:

- connect from landing page
- connect from Explore
- connect from a shared poll
- connect after tapping Vote
- signed verification inside the Nimiq Pay WebView
- return to intended action after verification
- public profile (wallet route and handle route)
- handle editing (keyboard: enter key submits, no viewport jump)
- no horizontal overflow at 360 px and above
- session restore / reconnect
- wallet switching mid-session and mid-verification

---

## 16. Test Design

Follows the repository's script-based verification convention
(`src/lib/api/*-test.ts` executed against the running dev server; no test
runner is configured).

### Onboarding (`v2b1-onboarding-test.ts`)

- first connection
- first verification (full challenge → sign → verify → profile bootstrap)
- existing verified wallet (surface resolves without re-signing)
- cancelled signature (clean connected-unverified state, no session, no profile)
- invalid signature (no session created)
- expired challenge (fresh challenge path)
- reused challenge (409, no second session)
- wallet switch (mid-verification abort; new wallet requires own verify)
- unauthorized/direct profile bootstrap (no cookie → 401)
- return-to-original-action for `vote`, `create_poll`, `profile`,
  `generic_connect`
- open-redirect rejection (`//evil.com`, `https://evil.com`, `/\evil`,
  backslash/scheme inputs → fallback behaviour)

### Profile (`v2b1-profile-test.ts`)

- verification creates exactly one profile
- repeated verification is idempotent (same row, `verified_at` unchanged)
- display name update (owner)
- handle creation
- handle rename (old handle released)
- duplicate handle → 409 `handle_taken`
- concurrent duplicate-handle race → exactly one winner
- reserved handle → rejected
- invalid handle (short/long/uppercase/special chars) → rejected
- canonical lowercase (input normalised)
- wallet route resolves canonical profile
- handle route resolves same profile
- non-owner edit attempt → 403/404 (session wallet mismatch)

### Privacy (`v2b1-privacy-test.ts`)

- public poll participation appears in activity
- poll title appears
- selected option **does not** appear (response shape has no option fields)
- private/draft poll activity does not appear
- public profile API exposes no auth/session secrets (no tokens, no hashes,
  no session rows)
- NIM totals use confirmed records only (`nim_contributions`, never intents)

### Backward compatibility (`v2b1-backward-test.ts`)

- existing polls (public and private)
- existing votes
- duplicate-vote rejection (one-wallet-one-vote intact)
- My Polls
- support flow (intents → confirmed contributions)
- V2A Explore (taxonomy, filters, pagination)
- existing verified users gain a profile via backfill/bootstrap without
  re-registration

### Mobile device QA

- Nimiq Pay physical-device checklist per §15, recorded in a review doc like
  the V2A.7 device-QA report.

---

## 17. Backward Compatibility Strategy

- **No destructive migration:** new table + additive indexes + functions only.
- Existing polls, votes, support history, receipts, and My Polls are
  untouched — no existing column or row is altered.
- The wallet-proof challenge/verify/session/logout cryptography is unchanged.
- Vote, publish, and support routes are unchanged; their 401 paths simply
  trigger the onboarding sheet with the appropriate intent instead of leaving
  the user stranded.
- `getVerifiedWalletSession` is unchanged; bootstrap rides on top of it.
- V2A taxonomy/Explore is untouched.
- Existing verified users: profile created automatically by (a) idempotent
  bootstrap on next verification, and (b) the one-time backfill of wallets
  with existing public activity — no re-registration, no data loss.

---

## 18. Relationship to Rewarded Participation (V2B.2+, deferred)

V2B.1 is the identity foundation only. **No rewards are implemented.**

The profile is designed so later systems can derive `confirmed NIM earned` and
reward participation history **from the future authoritative reward ledger**,
but no speculative reward state or counters are added now — `nimEarnedLuna`
is a constant `0` until the ledger exists.

Deferred to V2B.2+: creator-funded reward campaigns, prepaid NIM budget,
reward eligibility, isolated campaign reward vault, NIM settlement, Earn NIM
discovery, creator reward management.

---

## 19. Out of Scope

- Implementation, migrations, and the implementation plan (next steps)
- Reward campaigns / settlement / reward counters
- Bio, avatar upload, followers/following, badges, reputation/participation
  scores, streak systems
- Public-choice polls (explicit disclosure design deferred)
- Generic activity-feed table
- Old-handle redirects
- Hosted Supabase changes, `supabase db push`, linking, deployment, merging to
  main
- Any redesign of Votum's visual language

---

## 20. Rollout Constraints

- Continue on `feat/v2-participation-record`; no new branch in this step.
- Do **not** merge main; do **not** deploy; do **not** touch hosted Supabase;
  do **not** run `supabase db push`, `supabase link`, or `--linked`.
- Keep local-only `next.config.ts` (LAN `allowedDevOrigins`) unstaged.
- The design document is the only file committed in this step.

---

## 21. Self-Review

Checked against the review checklist:

- **Duplicate identity systems** — one new `participant_profiles` table; no
  parallel user store; wallet columns remain authoritative for activity.
- **Privacy leaks** — vote choices structurally excluded from the RPC/API
  shape; public boundary (`is_public` + live/closed) applied in every
  derivation; no session/token fields in profile responses.
- **Exposed vote choice** — impossible via the allowlisted response contract;
  activity SQL never selects `option_id`.
- **Forced onboarding/profile friction** — no mandatory profile-completion
  wizard; single non-blocking message; return-to-intent everywhere.
- **Wallet/profile mismatches** — server derives wallet from session for all
  writes; mismatch states already exist in the provider and are reused.
- **Handle race conditions** — partial unique index is authoritative; atomic
  claim update yields exactly one winner.
- **Open redirects** — strict internal-path validator; client-side push only.
- **Destructive migration assumptions** — additive only; backfill is
  `INSERT ... ON CONFLICT DO NOTHING`.
- **Unnecessary social/reputation scope** — excluded (§19).
- **Unbounded/N+1 queries** — bounded merged RPCs, index-served aggregates,
  no feed table.
- **Contradictions with V2A** — preserves taxonomy/Explore and the public-poll
  boundary exactly; no V2A files are modified by this design.
- **Placeholders/TODO/TBD** — none in this document.

---

## Completion Criteria (for the future implementation step)

V2B.1 is complete when:

- Onboarding is one shared surface with all eight states, reachable from every
  intent trigger, returning to the user's action
- Verification never auto-signs
- One profile per verified wallet, idempotent bootstrap, automatic legacy-user
  profiles
- `/profile/[wallet]`, `/u/[handle]`, `/profile/edit` work per spec
- Handle rules are enforced server-side with a unique-index race guarantee
- Profile stats and recent activity are derived, bounded, and N+1-free
- Vote choices never appear anywhere in profile data
- The profile API exposes public allowlisted fields only
- All V2B.1 test suites pass (onboarding, profile, privacy, backward
  compatibility)
- All existing V2A suites pass unchanged
- Typecheck, lint, and production build pass
- Nimiq Pay physical-device QA passes
- No hosted Supabase changes, no deploy, no merge to main
