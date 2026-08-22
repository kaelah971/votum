# V2B.1 — Nimiq Pay Device QA Checklist

> **Status: COMPLETE** — T12 physical device session finished; final
> automated regression gate run and green.
>
> All `PASS` results come from explicit user observation during a real Nimiq Pay
> device session. Historical `FAIL → FIX → RETEST` evidence is preserved in the
> checklist notes below. One item remains intentionally **not** PASS.

---

## Final Summary (T12)

- Physical iPhone / Nimiq Pay device QA completed on the local HTTP LAN host.
- Mobile layout sweep is clean — **#19 No horizontal overflow = PASS** (manual
  sweep of landing, Explore, poll, Create, public profile, Edit profile, and
  hamburger/product navigation: no horizontal drag, nothing clipped outside the
  mobile viewport).
- All local functional flows passed after the discovered fixes were applied.
- **#21 Same-wallet reconnect/session restore remains the only HTTPS-required
  follow-up** — it is a LOCAL HTTP HOST LIMITATION, not a Votum code bug, and is
  **NOT** marked PASS.

### Physical bugs discovered and fixed during T12

| # | Bug (physical discovery) | Fix |
|---|--------------------------|-----|
| 1 | Landing page missing WalletButton (no mobile wallet entry point) | Expose wallet onboarding on mobile landing (`4c2d396`) |
| 2 | Wallet menu clipped offscreen on mobile | Keep wallet menu inside mobile viewport (`ba94752`) |
| 3 | Spaced-NQ profile link produced 404 (`%20`-encoded route segment) | Route-safe spaceless NQ profile path (`4cc548c`) |
| 4 | PollHeader locale hydration mismatch (server `, ` vs client `at`) | Deterministic split date+time formatter (`1937d32`) |
| 5 | `/create` entry not gated by verification | Verified, matched-session `CreateGate` (`8e97eb0`) |
| 6 | Product drawer lacked profile/edit access | Session-driven Account section in product drawer (`d484001`) |
| 7 | Hex-vs-NQ session reconciliation bug (verified session not restored) | Canonical wallet key + NQ-form session endpoint (`5b453f0`) |
| 8 | Rejected signature leaked an unhandled promise rejection / red overlay | Defensive rejection handling + safe denial classification (`7b9f2dc`) |

---

## Environment

| Field | Value |
|-------|-------|
| Physical device model | *supplied interactively during T12* |
| OS / version | *supplied interactively during T12* |
| Nimiq Pay version / build | *supplied interactively during T12 (if visible)* |
| LAN URL | `http://192.168.0.3:3000` |
| Tested commit | `de4a6b3f0bfe4743d016cd299ab3a5525fb09ba6` (start) → `7b9f2dc` (final, after all T12 fixes) |
| Branch | `feat/v2-participation-record` |
| Notes / screenshots | *supplied interactively during T12* |

---

## Checklist

| # | Item | Result | Notes |
|---|------|--------|-------|
| 1 | Mini App launches inside Nimiq Pay | **PASS** | T12 physical observation: landing page renders inside Nimiq Pay. |
| 2 | Landing-page Connect Wallet / wallet entry point | **PASS** | T12 physical retest: connected wallet control visible and tappable on physical iPhone (shows `NQ47 V...`). |
| 3 | Explicit Verify ownership step | **PASS** | T12 physical retest: explicit Verify ownership step shown and completed on physical iPhone. |
| 4 | Successful signed-message verification | **PASS** | T12 physical retest: wallet successfully verified on physical iPhone. |
| 5 | Automatic profile bootstrap | **PASS** | FAIL/BLOCKED DURING PHYSICAL QA: wallet menu retest PASS — user opened the verified menu and tapped View profile on the physical iPhone, but it opened Votum's 404 page ("PAGE NOT FOUND / This decision is not here"). Root cause: View profile href embedded the human-readable NQ address with spaces; the browser URL-encodes spaces to `%20`, and the `/profile/[wallet]` route receives the `%20`-encoded segment which fails wallet normalisation → notFound. The API path (which URL-decodes query params) resolved fine. Fixed by building a route-safe space-free NQ path for the profile link (and the onboarding profile intent) while keeping the wallet the authoritative identity. Verified: spaceless-NQ route 200, canonical-hex route 200, API accepts human-readable NQ, unknown wallets still 404. **PASS after T12 physical retest** — profile link opens the public profile on-device. |
| 6 | Generic connect returns to original page | **PASS** | T12 physical observation confirmed the generic connect flow returns to the originating page. |
| 7 | Vote-triggered onboarding returns to same poll | **PASS** | T12 physical observation: vote-triggered onboarding completed verification and returned to the same poll. |
| 8 | Vote completes after verification | **PASS** | T12 physical observation: vote completed successfully after on-device verification. |
| 9 | Duplicate vote remains blocked | **PASS** | T12 physical observation: after refreshing the already-voted poll, the previous Vote confirmed state remained; no second vote/cast-vote action appeared; existing vote remained 1 total vote. |
| 10 | Create-triggered onboarding returns to create flow | **PASS** | FAIL FOUND DURING PHYSICAL QA: a connected-but-unverified wallet could enter `/create` and use the full creation form without triggering ownership verification. Root cause: `/create` gated verification only at Publish (`handlePublish`), not at entry. Fixed by gating the create form behind a verified, matched session (`CreateGate`): disconnected and connected-unverified visitors get the shared onboarding with `create_poll` intent and return to `/create`; verified creators render the form normally. Server-side publish verification retained (defense in depth). **PASS after T12 physical retest** — unverified entry routes through onboarding; verified creators reach the form. |
| 11 | Public canonical profile renders | **PASS** | T12 physical observation: canonical profile page renders on-device. |
| 12 | Handle profile route renders | **PASS** | T12 physical observation: `/u/[handle]` route renders on-device. |
| 13 | Selected vote option remains absent from public profile | **PASS** | T12 physical observation: public profile shows no selected vote option. |
| 14 | Edit profile page renders for owner | **PASS** | T12 physical observation: edit profile renders for the verified owner. |
| 15 | Display-name update | **PASS** | T12 physical observation: display-name update persisted. |
| 16 | Handle update | **PASS** | T12 physical observation: handle update persisted. |
| 17 | Handle validation/availability UX | **PASS** | T12 physical observation: handle validation and availability UX behaved correctly. |
| 18 | Mobile keyboard usability | **PASS** | T12 physical observation: mobile keyboard usable; no obscured inputs. |
| 19 | No horizontal overflow | **PASS** | T12 final physical observation: manual sweep of landing, Explore, poll, Create, public profile, Edit profile, and hamburger/product navigation — no page could be horizontally dragged and no content/menu/input/button was clipped outside the mobile viewport. |
| 20 | Disconnect behavior | **PASS** | T12 physical observation: disconnect returns the app to the disconnected state without leaking the verified session. |
| 21 | Same-wallet reconnect/session restore | **FAIL — LOCAL HTTP HOST LIMITATION — HTTPS RETEST REQUIRED** | First FAIL: after closing/reopening the Mini App, reconnecting the exact same previously verified wallet showed "Verify this wallet". First fix (commit 5b453f0): session endpoint returns user-friendly NQ form + canonical identity comparison. Second physical retest (≈20:56 local) still FAILED — same symptom. Diagnosis (dev-only instrumentation): server path is fully correct (valid cookie → `verified:true` with user-friendly NQ form matching `activeAccount`; DB `wallet_sessions` row persists and is unexpired). Root cause is **not** Votum code: the `votum_session` cookie (httpOnly, SameSite=Lax, Secure=false in dev) is **absent after Nimiq Pay iOS Mini App close/reopen over local HTTP** — the WebView does not carry the cookie back; a fresh challenge→verify was issued at 20:56 (new `wallet_sessions` row created 19:56:01Z), proving the session had to be re-established. Classified as **LOCAL HTTP HOST LIMITATION — HTTPS RETEST REQUIRED**. Not a Votum code bug; no auth weakening applied. **NOT marked PASS.** |
| 22 | Wallet-switch requires verification of the new wallet | **PASS** | T12 physical observation: switched from verified NQ47… to unverified NQ34…; active wallet changed, old verified session was NOT transferred, Votum required verification of NQ34…, and NQ47's profile/edit actions were not exposed as if owned by NQ34. |
| 23 | Cancelled/rejected signature recovery | **PASS** | FAIL FOUND DURING PHYSICAL QA: after tapping "Verify this wallet", rejecting the Nimiq signature request on a retry produced a red Next.js runtime overlay ("Runtime Error [object Object]", stack `coerceError` / `onUnhandledRejection`). Root cause: the Nimiq Pay SDK rejects `provider.sign()` with a **plain object** — confirmed in dev-server logs as `{ code: 4001, message: "User rejected the request." }` — and `signMessage`'s catch only classified denial for `Error` instances, so a plain-object cancellation was misclassified and the raw SDK rejection promise could surface as an unhandled rejection. Fixed: `signMessage`/`requestAccounts` now (1) attach a defensive rejection handler to the raw SDK promise so it can never become an unhandled rejection, and (2) classify plain-object/nested SDK denials (`error.type`, `message`, `code` incl. 4001, "reject"/"denied"/"cancelled") via safe normalization; `WalletOnboardingSheet` wraps async button handlers so event-handler promises never reject. Cancellation now returns to the connected-but-unverified state with no session, no verify POST, no bootstrap, and no overlay. **PASS after T12 physical retest** — rejection returns cleanly with no runtime overlay. |
| 24 | No red Next.js runtime issue overlay | **PASS** | FAIL FOUND DURING PHYSICAL QA: poll page refresh on physical iPhone produced a React hydration mismatch in `PollHeader`/`PollVotingPanel` because server/client closing-date strings differed. Server: `Aug 22, 2026, 1:42 AM`; client: `Aug 22, 2026 at 1:42 AM`. Root cause: `formatClosingTime` passed date AND time options to a single `toLocaleDateString("en-US", …)`, whose combined date+time pattern is engine-dependent (Node ICU uses `, `; WebKit uses `at`). Fixed with a deterministic split date-part + time-part formatter joined with `, `. The #23 cancellation overlay source was also removed by the #23 fix. **PASS after T12 physical retest** — no red Next.js runtime overlay appears on refresh or on signature rejection. |

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

Status: **PASS after T12 physical retest** — poll-page refresh on the physical
iPhone produces no red Next.js runtime overlay; closing-time text is
byte-identical between server and client.

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

Status: **PASS after T12 physical retest** — profile/edit access reachable from
the in-app product drawer on-device.

---

## New physical defect — same-wallet reconnect does not restore verified session

After closing and reopening the Mini App, the wallet connection is lost as
expected (state A is ephemeral). Reconnecting the **same** previously verified
wallet must restore the verified Votum session (state B) without a new
signature. On the physical iPhone it instead showed "Verify this wallet".

### First fix (commit `5b453f0`)

`/api/wallet-proof/session` returned `walletAddress: session.address` — the
**canonical hex** stored in `wallet_sessions` — while the connected
`activeAccount` from the Nimiq SDK is the **user-friendly NQ form**
(`NQ47 VGR3 …`). The provider, `WalletButton`, and `deriveOnboardingState`
compared them with naive string equality, which never matches hex vs NQ.
Fixed by returning the user-friendly NQ form from the session endpoint and
adding a shared `canonicalWalletKey(address)` (strip whitespace + uppercase)
for every wallet↔session identity comparison. This fix is correct and
retained; it makes server + client reconciliation fully canonical.

### Second physical retest (≈20:56 local) — still fails

Same symptom after the canonical fix. Dev-only instrumentation + DB evidence:

1. **`wallet_sessions` row persisted and remained valid** — unexpired,
   unrevoked, canonical wallet `ec323ef660c913e4a3f0659bfb6b63333255b278`.
2. **Server path proven correct end-to-end:** a request carrying a valid
   `votum_session` cookie returned `{ verified: true, walletAddress: "NQ47
   VGR3 VVK0 R49X 98YG CNDY NST3 6CR5 BCKQ" }` — the user-friendly NQ form that
   `canonicalWalletKey(activeAccount)` matches. No server bug.
3. **Cookie attributes:** `votum_session`, `httpOnly`, `sameSite=lax`,
   `secure=false` in dev (`NODE_ENV != production` / no
   `NEXT_PUBLIC_APP_URL`), `path=/`, `maxAge=12h`.
4. **Cookie absent after Mini App close:** the physical reopen produced a
   fresh `challenge → verify → bootstrap` sequence and a new `wallet_sessions`
   row created at `2026-08-21T19:56:01Z` (= 20:56 local) — the session had to
   be re-established from scratch, which only happens when the browser did not
   carry the `votum_session` cookie back into the reopened Mini App.
5. **Conclusion:** the cookie does not survive the Nimiq Pay iOS Mini App
   WebView close/reopen lifecycle over **local HTTP** (`http://192.168.0.3:3000`).
   This is a host/local-HTTP WebView storage limitation, **not** a Votum code
   bug. Votum's server session persistence and canonical reconciliation are
   correct.

No auth architecture was weakened (no localStorage/sessionStorage tokens, no
token exposure, Secure flag logic unchanged). HTTPS production Mini App
behavior cannot be confirmed on this local origin.

Status: **FAIL — LOCAL HTTP HOST LIMITATION. HTTPS RETEST REQUIRED** to
determine whether the Nimiq Pay WebView persists the cookie on a secure
production origin. **NOT marked PASS.** This is the only remaining follow-up.

---

## New physical defect — rejected wallet signature causes unhandled runtime error

T12 #23. Physical sequence: connected-but-unverified NQ34… → "Verify this
wallet" → Nimiq Pay signature approval → user rejects. First rejection
returned cleanly; a subsequent retry + rejection produced a red Next.js
runtime overlay "Runtime Error [object Object]" (stack `coerceError` /
`onUnhandledRejection`).

Diagnosis (evidence):

1. **Rejecting promise/boundary:** `provider.sign(message)` in
   `@nimiq/mini-app-sdk` rejects when the user cancels (the adapter's pending
   promise rejects and propagates up through `provider.request()`).
2. **Safe rejection shape (confirmed in dev-server logs):** the Nimiq Pay SDK
   rejects with a **plain object** `{ code: 4001, message: "User rejected the
   request." }` — not an `Error`. When stringified by Next's dev overlay this
   appears as `[object Object]`.
3. **Why it escaped:** `signMessage`'s catch only ran `isPermissionDenial` for
   `err instanceof Error`; a plain-object rejection fell through to
   `{ error: "Unknown signature error" }` and, more importantly, the raw SDK
   promise could surface as an unhandled rejection. React does not await
   `onClick` handler promises, so a rejecting handler promise also escapes to
   the window.
4. **Cancellation vs genuine failure:** now distinguished — plain-object /
   nested SDK denials (`error.type`, `message`, `code` incl. 4001, and
   "reject"/"denied"/"cancelled") map to `{ denied: true }`; genuine
   SDK/network errors still map to `{ error: … }` (recoverable failure).

Fix:

- `signMessage`/`requestAccounts` attach a defensive rejection handler to the
  raw SDK promise so it can never become an unhandled rejection, and classify
  plain-object denials via safe normalization (`isDenialFromThrown`,
  `safeErrorSummary`) that only exposes name/code/message.
- `WalletOnboardingSheet` wraps async button handlers (`safeClick`) so
  event-handler promises never reject to the window.

Result: a user-initiated cancellation returns to the connected-but-unverified
state; no session, no verify POST, no profile bootstrap, no overlay; retry
works; repeated cancellation is safe; genuine errors still surface as
recoverable failures.

Status: **PASS after T12 physical retest**. T12 #23 and #24 both confirmed
clean on-device with no runtime overlay.

---

## Known local anomalies (audit only — NOT repaired)

- **publish-test residue accumulation:** `service_role` DELETE on
  `polls`/`poll_options`/`poll_publication_requests` was revoked in
  `20260731063021` (pre-V2B.1). The publish-test's own stale-cleanup and
  end-cleanup therefore silently no-op, so each run leaves residue
  ("Concurrent test?" polls etc.) that breaks the NEXT run's "exactly 1 poll"
  assertion. Passed green during the final gate after manually clearing residue
  (creator wallets `0000…`/`01…`). Pre-existing test-infra quirk, not a V2B.1
  code regression; no grant re-added (no auth weakening).
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
