# V2B.1 — Nimiq Pay Device QA Checklist

> **Status: IN PROGRESS** — T12 physical session in progress.
>
> All checklist items start as `PENDING`. Every `PASS`/`FAIL` must come from an
> explicit user observation during a real Nimiq Pay device session. Results are
> recorded interactively, one step at a time — never pre-filled.

---

## Environment

| Field | Value |
|-------|-------|
| Physical device model | *to be supplied by user* |
| OS / version | *to be supplied by user* |
| Nimiq Pay version / build | *to be supplied by user (if visible)* |
| LAN URL | `http://192.168.0.3:3000` |
| Tested commit | `de4a6b3f0bfe4743d016cd299ab3a5525fb09ba6` |
| Branch | `feat/v2-participation-record` |
| Notes / screenshots | *to be supplied by user* |

---

## Checklist

| # | Item | Result | Notes |
|---|------|--------|-------|
| 1 | Mini App launches inside Nimiq Pay | **PASS** | T12 physical observation: landing page renders inside Nimiq Pay. |
| 2 | Landing-page Connect Wallet / wallet entry point | **PASS** | T12 physical retest: connected wallet control visible and tappable on physical iPhone (shows `NQ47 V...`). |
| 3 | Explicit Verify ownership step | **PASS** | T12 physical retest: explicit Verify ownership step shown and completed on physical iPhone. |
| 4 | Successful signed-message verification | **PASS** | T12 physical retest: wallet successfully verified on physical iPhone. |
| 5 | Automatic profile bootstrap | **READY FOR RETEST** | FAIL/BLOCKED DURING PHYSICAL QA: wallet menu retest PASS — user opened the verified menu and tapped View profile on the physical iPhone, but it opened Votum's 404 page ("PAGE NOT FOUND / This decision is not here"). Root cause: View profile href embedded the human-readable NQ address with spaces; the browser URL-encodes spaces to `%20`, and the `/profile/[wallet]` route receives the `%20`-encoded segment which fails wallet normalisation → notFound. The API path (which URL-decodes query params) resolved fine. Fixed by building a route-safe space-free NQ path for the profile link (and the onboarding profile intent) while keeping the wallet the authoritative identity. Verified: spaceless-NQ route 200, canonical-hex route 200, API accepts human-readable NQ, unknown wallets still 404. **NOT marked PASS — physical retest required.** |
| 6 | Generic connect returns to original page | PENDING | |
| 7 | Vote-triggered onboarding returns to same poll | PENDING | |
| 8 | Vote completes after verification | PENDING | |
| 9 | Duplicate vote remains blocked | **PASS** | T12 physical observation: after refreshing the already-voted poll, the previous Vote confirmed state remained; no second vote/cast-vote action appeared; existing vote remained 1 total vote. |
| 10 | Create-triggered onboarding returns to create flow | **READY FOR RETEST** | FAIL FOUND DURING PHYSICAL QA: a connected-but-unverified wallet could enter `/create` and use the full creation form without triggering ownership verification. Root cause: `/create` gated verification only at Publish (`handlePublish`), not at entry. Fixed by gating the create form behind a verified, matched session (`CreateGate`): disconnected and connected-unverified visitors get the shared onboarding with `create_poll` intent and return to `/create`; verified creators render the form normally. Server-side publish verification retained (defense in depth). **NOT marked PASS — physical retest required.** |
| 11 | Public canonical profile renders | PENDING | |
| 12 | Handle profile route renders | PENDING | |
| 13 | Selected vote option remains absent from public profile | PENDING | |
| 14 | Edit profile page renders for owner | PENDING | |
| 15 | Display-name update | PENDING | |
| 16 | Handle update | PENDING | |
| 17 | Handle validation/availability UX | PENDING | |
| 18 | Mobile keyboard usability | PENDING | |
| 19 | No horizontal overflow | PENDING | |
| 20 | Disconnect behavior | PENDING | |
| 21 | Same-wallet reconnect/session restore | **READY FOR RETEST** | FAIL FOUND DURING PHYSICAL QA: after closing and reopening the Mini App, wallet connection was lost as expected. Reconnecting the exact same previously verified wallet resulted in "Verify this wallet" rather than restoring "Session verified". Root cause (Votum code bug): `/api/wallet-proof/session` returned the verified wallet as canonical hex (the value stored in `wallet_sessions`), while the connected `activeAccount` from the Nimiq SDK is the user-friendly NQ form (`NQ47 VGR3 …`); the provider compared them with naive string equality, which never matches hex vs NQ, so a valid session could not be restored. The `wallet_sessions` row persisted and remained unexpired. Fixed: session endpoint returns the user-friendly NQ form; all wallet/session identity comparisons use a shared canonical key (`canonicalWalletKey`: strip whitespace + uppercase) in `VotumSessionProvider`, `WalletButton`, and `deriveOnboardingState`. **NOT marked PASS — physical retest required.** |
| 22 | Wallet-switch requires verification of the new wallet | PENDING | |
| 23 | Cancelled/rejected signature recovery | PENDING | |
| 24 | No red Next.js runtime issue overlay | **READY FOR RETEST** | FAIL FOUND DURING PHYSICAL QA: poll page refresh on physical iPhone produced a React hydration mismatch in `PollHeader`/`PollVotingPanel` because server/client closing-date strings differed. Server: `Aug 22, 2026, 1:42 AM`; client: `Aug 22, 2026 at 1:42 AM`. Root cause: `formatClosingTime` passed date AND time options to a single `toLocaleDateString("en-US", …)`, whose combined date+time pattern is engine-dependent (Node ICU uses `, `; WebKit uses `at`). Fixed with a deterministic split date-part + time-part formatter joined with `, `. **NOT marked PASS — physical retest required.** |

---

## New physical defect — Poll date hydration mismatch

Poll page refresh on the physical iPhone produced a React hydration mismatch
in `PollHeader`/`PollVotingPanel`. Server rendered `Aug 22, 2026, 1:42 AM`;
client rendered `Aug 22, 2026 at 1:42 AM`. Root cause: `formatClosingTime`
(`src/lib/format.ts`) passed both date and time options to a single
`toLocaleDateString("en-US", …)`. That combined date+time pattern is
engine-dependent — Node ICU emits `, ` between date and time, WebKit (iOS)
emits `at`. The poll's `closingAt` instant is unchanged; timezone semantics
preserved (user-local). Fixed by splitting into a date part and a time part
(separate explicit `toLocale*` calls) joined with a fixed `, `, so SSR and
client produce byte-identical text.

Status: **READY FOR PHYSICAL RETEST**. T12 #24 remains **not PASS** until a
physical device confirms the red runtime overlay no longer appears.

---

## New physical UX observation — product navigation lacks profile access

Landing WalletButton exposes View/Edit profile for verified users, but the
in-app product hamburger drawer previously exposed only Explore, Create, How
it works, My Polls, Drafts, Insights, and a wallet pill — no discoverable
profile/account actions.

Fixed by adding a session-driven **Account** section to the product drawer
(`ProductNavAccountActions`) that reuses the same canonical profile paths and
session/onboarding truth as WalletButton:

- verified → **View profile** (route-safe `profileWalletPath`) + **Edit profile**
- connected-but-unverified → **Verify this wallet**
- disconnected → **Connect wallet**

The drawer is scrollable (`max-h-[calc(100vh-3.5rem)] overflow-y-auto`) so the
account section stays reachable on narrow Nimiq Pay screens.

Status: **READY FOR PHYSICAL RETEST**.

---

## New physical defect — same-wallet reconnect does not restore verified session

After closing and reopening the Mini App, the wallet connection is lost as
expected (state A is ephemeral). Reconnecting the **same** previously verified
wallet must restore the verified Votum session (state B) without a new
signature. On the physical iPhone it instead showed "Verify this wallet".

Diagnosis (evidence):

1. **`wallet_sessions` row persisted** — the DB had valid, unexpired,
   unrevoked sessions for the physical wallet
   (`ec323ef660c913e4a3f0659bfb6b63333255b278`, canonical hex).
2. **Session remained unexpired** (12h TTL; rows created 2026-08-21 were still
   within validity).
3. **Cookie attributes** (verify route / `session.ts`): name `votum_session`,
   `httpOnly`, `sameSite=lax`, `secure=false` in dev (`NODE_ENV != production`
   or no `NEXT_PUBLIC_APP_URL`), `path=/`, `maxAge=12h`. Secure is intentionally
   off so the cookie works over local HTTP.
4. **Root cause (Votum code bug, not host):** `/api/wallet-proof/session`
   returned `walletAddress: session.address` — the **canonical hex** stored in
   `wallet_sessions`. The connected `activeAccount` from the Nimiq SDK is the
   **user-friendly NQ form** (`NQ47 VGR3 …`). The provider, `WalletButton`, and
   `deriveOnboardingState` all compared them with naive string equality
   (`trim().toLowerCase()`), which never matches hex vs NQ — so a valid session
   could never be reconciled to the reconnected wallet. This reproduces even in
   a normal browser refresh (cookie present), independent of Nimiq Pay's
   WebView cookie handling.

Fix:

- `GET /api/wallet-proof/session` now returns the wallet in user-friendly NQ
  form (`toUserFriendlyAddress`), matching the SDK's `activeAccount`.
- Added a shared client-safe `canonicalWalletKey(address)` (strip whitespace +
  uppercase) used for every wallet↔session identity comparison in
  `VotumSessionProvider`, `WalletButton`, and `deriveOnboardingState`.

Same-wallet reconnect now restores `Session verified` with no new signature;
a different wallet reconnect still requires fresh verification. No session
tokens are stored client-side; no cookie security weakened.

Status: **READY FOR PHYSICAL RETEST**.

---

## Known local anomalies (audit only — NOT repaired)

- **Local migration-ledger entry missing:** repo contains
  `20260805000000_drop_obsolete_confirm_overload.sql` but the local
  `supabase_migrations.schema_migrations` ledger does not contain it. Its
  schema effect already exists locally (the obsolete 4-arg
  `confirm_nim_contribution_atomic` overload is absent; only the canonical
  5-arg overload remains). No repair/registration/reset performed.
- **Clean-room verification required before hosted rollout:**
  1. Fresh instance: `supabase migration list` — confirm the discrepancy is
     local-only.
  2. Apply `20260805000000` via the Supabase CLI so the ledger records it.
  3. Verify: 4-arg overload absent, 5-arg overload present, confirm route
     behavior unchanged.
  4. Then proceed with the hosted migration gate.
