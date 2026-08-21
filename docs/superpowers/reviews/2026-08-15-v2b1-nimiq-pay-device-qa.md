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
| LAN URL | `http://192.168.1.58:3000` |
| Tested commit | `de4a6b3f0bfe4743d016cd299ab3a5525fb09ba6` |
| Branch | `feat/v2-participation-record` |
| Notes / screenshots | *to be supplied by user* |

---

## Checklist

| # | Item | Result | Notes |
|---|------|--------|-------|
| 1 | Mini App launches inside Nimiq Pay | **PASS** | T12 physical observation: landing page renders inside Nimiq Pay. |
| 2 | Landing-page Connect Wallet | **READY FOR RETEST** | FAIL FOUND DURING PHYSICAL QA: no visible/tappable Votum wallet control in the mobile landing header (logo, `+127` stat pill, and `Create` were shown; the `+127` pill is a static NIM-signalled stat, not interactive). Fixed by rendering `WalletButton` in the marketing header. **NOT marked PASS — physical retest required.** |
| 3 | Explicit Verify ownership step | PENDING | |
| 4 | Successful signed-message verification | PENDING | |
| 5 | Automatic profile bootstrap | PENDING | |
| 6 | Generic connect returns to original page | PENDING | |
| 7 | Vote-triggered onboarding returns to same poll | PENDING | |
| 8 | Vote completes after verification | PENDING | |
| 9 | Duplicate vote remains blocked | PENDING | |
| 10 | Create-triggered onboarding returns to create flow | PENDING | |
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
| 21 | Same-wallet reconnect/session restore | PENDING | |
| 22 | Wallet-switch requires verification of the new wallet | PENDING | |
| 23 | Cancelled/rejected signature recovery | PENDING | |
| 24 | No red Next.js runtime issue overlay | PENDING | |

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
