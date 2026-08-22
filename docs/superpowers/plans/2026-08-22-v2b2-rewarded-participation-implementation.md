# V2B.2 — Creator-Funded Rewarded Participation (Implementation Plan)

**Status:** Plan — no implementation yet.
**Date:** 2026-08-22
**Branch:** `feat/v2-participation-record`
**Starting HEAD:** `80288e523422c89c490eac2f1444f76c3ed39f8d`
**Design spec:** `docs/superpowers/specs/2026-08-22-v2b2-rewarded-participation-design.md`
**Locked decisions:** D1–D10 (see design spec §0.1)
**Depends on:** V2A (Explore/publish/vote/support), V2B.1 (verified identities),
and a **mandatory Slice 0 custody spike** (server-side Nimiq signing/broadcast).

> This document plans V2B.2 as small, independently verifiable checkpoints
> (V2B.2.1 … V2B.2.14). Each checkpoint is a commit boundary with its own goal,
> files, invariants, tests, and acceptance criteria. Nothing here is
> implemented yet.

---

## 0. Global Constraints (apply to every checkpoint)

- **Additive only.** No existing table/column/row is altered. No-campaign poll
  behaviour is byte-identical to today.
- **Integer Luna only.** All stored/accounted money is integer Luna.
  Decimal NIM exists only at the UI boundary.
- **Chain truth.** Client callbacks are never financial truth. Every financial
  state transition is `INTENT → BROADCAST → CHAIN OBSERVATION → DB CONFIRMATION`.
- **Atomic transitions only.** Financial state changes happen exclusively in
  security-definer DB functions (single implicit transaction) — never in
  route-handler read-then-write.
- **No reward CTA on an unfunded campaign.** A rewarded poll is advertised only
  when its campaign is `funded` with capacity.
- **Custodial honesty.** Votum-custodied reward infrastructure; key material
  never in plaintext/logs/API/browser (§6.1 of design spec).
- **Local Supabase only.** Every checkpoint runs against the local dev server +
  local Supabase (`127.0.0.1:54321`). **No `supabase db push`, no link, no
  hosted Supabase, no deploy, no merge to main.**
- **#21 is NOT part of V2B.2.** Same-wallet reconnect/session-restore HTTPS
  retest is carried to the hosted/deployment gate as an independent
  prerequisite.
- **Local-only files remain untouched:** `next.config.ts` (unstaged),
  `scripts/seed-device-qa-fixtures.ts`, `dev-server-t12.log`,
  `dev-server-t12.err.log`.

---

## 0.1 Money-Safety Atomic Boundaries (reference)

These are the exact DB operations that **must** be security-definer RPCs /
single-transaction functions. Two ordinary route handlers must never implement
a financial transition with naïve read-then-write.

| # | Atomic operation | Advisory lock | Unique/backstop | Purpose |
|---|------------------|---------------|-----------------|---------|
| 1 | **Funding confirmation** `confirm_reward_funding_atomic` | campaign lock | funding `reference` UNIQUE; partial-unique tx hashes | Credit `funded_amount_luna`, set `funded`, split principal/fee/excess (D5/D9) |
| 2 | **Participation + final-slot reward reservation** `claim_reward_receipt_atomic` (fused with `cast_poll_vote_atomic`) | campaign lock (same key as vote) | `UNIQUE(campaign_id, participant_wallet)`; capacity CHECK | Exactly one winner at cap boundary; sets `first_reservation_at` (D10) |
| 3 | **Payout state transition** `begin_reward_payout_atomic` | receipt lock | guarded `eligible/reserved → payout_pending` | Reserve the payout attempt, increment attempt number |
| 4 | **Payout chain confirmation** `confirm_reward_payout_atomic` | receipt lock | payout hash partial-unique; guarded `payout_pending → paid` | Mark paid + increment `paid_amount_luna` only on confirmed hash |
| 5 | **Payout retry creation** `retry_reward_payout_atomic` | receipt lock | `UNIQUE(receipt_id, attempt_number)` | New attempt from `retryable`; bounded attempts |
| 6 | **Campaign close** `close_reward_campaign_atomic` | campaign lock | state guard | Only when poll closed; finalize eligibility window |
| 7 | **Refund reservation** `initiate_reward_refund_atomic` | campaign lock | one active refund per campaign; requires no unresolved reserved/payout_pending (D4) | Compute remainder (principal + fee reserve + excess); freeze refundable amount |
| 8 | **Refund confirmation** `confirm_reward_refund_atomic` | campaign lock | refund hash partial-unique; guarded `pending → confirmed` | Mark refunded; final state |

Every one of these is a `SECURITY DEFINER` function with `SET search_path = ''`,
`STABLE`/`VOLATILE` as appropriate, invoked only via the server admin client,
with no grant to `anon`/`authenticated`. Advisory lock keys are deterministic
from `campaign_id`/`receipt_id` (15-hex bigint pattern already used by
`publish_poll_atomic`).

---

## 0.2 Chain Reconciliation Model (reference)

For funding, payouts, and refunds, the plan strictly separates:

```
INTENT        DB row created (`submitted`/`pending`) with unique reference/hash slot
BROADCAST     server (payout/refund) or Nimiq Pay client (funding) sends the tx
CHAIN OBSERV.  getTransactionByHash (RPC) → verified fields
DB CONFIRM    atomic RPC flips state only after confirmed observation
```

Client callbacks set no financial truth; they only provide a hash to observe.
A reconciliation job (server route/cron mirroring the support confirm loop)
re-derives state from confirmed hashes when a callback/response is lost.

---

## 0.3 Payout Failure Safety (reference)

| Failure | Design |
|---------|--------|
| A. Broadcast succeeds, HTTP response dies | Payout attempt row persists; reconciliation re-observes the stored hash → confirms. |
| B. Chain confirms, DB write fails | Observer re-checks hash; confirm RPC idempotent via guarded transition + partial-unique hash. |
| C. DB marks pending, broadcast never occurs | Payout attempt `failed`/`retryable`; no receipt reaches `paid` without a confirmed hash; retry path re-broadcasts. |
| D. Same payout worker retries | `UNIQUE(receipt_id, attempt_number)` + guarded state; a duplicate attempt returns `replay`/`attempt_exists`. |
| E. Crash between signing and persistence | Sign-and-broadcast is the boundary; if persistence failed, reconciliation observes the broadcast hash or re-broadcasts under a fresh attempt. |
| F. Duplicate transaction observation | Partial-unique hash across the whole payout ledger; one hash used once. |
| G. Insufficient fee reserve | Broadcast gated on fee coverage; attempt `failed` (`fee_reserve_insufficient`); creator notified to top up (D9). |

---

## Checkpoints

---

### V2B.2.1 — Domain contracts + reward migration (foundation)

**Goal:** Define the V2B.2 domain types/constants and add the 5 reward tables +
security-definer functions + grants. Everything later builds on these.

**Likely files/modules:**
- `src/types/rewards.ts` (new): campaign/funding/receipt/payout/refund TS types
  mirroring the DB rows.
- `src/lib/rewards/constants.ts` (new): `MIN_REWARD_PER_PARTICIPANT_LUNA`
  (1000n), `ESTIMATED_TX_FEE_LUNA`, fee-reserve formula, payout attempt bound.
  **One source of truth — no scattered literals.**
- `supabase/migrations/20260822000000_v2b2_rewarded_participation.sql` (new,
  additive only).
- `src/types/database.ts`: add the 5 tables + RPC signatures.

**Schema/RPC work:**
- Tables: `reward_campaigns`, `reward_funding_transactions`, `reward_receipts`,
  `reward_payout_attempts`, `reward_refunds` per design spec §16, including the
  `reward_principal_luna` / `fee_reserve_luna` / `refundable_excess_luna` /
  `fee_spent_luna` / `first_reservation_at` columns and all CHECKs.
- Security-definer functions (bodies in this migration): the 8 atomic
  boundaries from §0.1.
- Grants: service_role CRUD on reward tables; EXECUTE on the atomic RPCs to
  service_role only; one anon-executable `get_public_reward_campaign` function
  for the public reward surface (D7), SECURITY DEFINER, `search_path=''`.
- RLS: enable on all 5 tables; `REVOKE ALL FROM anon, authenticated`.

**Invariants introduced:**
- One campaign per poll (`poll_id UNIQUE`).
- Capacity ≤ max; principal = per × max; total = principal + fee reserve.
- `paid_amount_luna + fee_spent_luna <= funded_amount_luna`.
- One reward per wallet per campaign (`UNIQUE(campaign_id, participant_wallet)`).
- Reward tables never reference `option_id` or `poll_options`.

**Tests BEFORE/with implementation:**
- Contract tests `src/lib/api/v2b2-schema-test.ts`: CHECKs reject bad rows,
  uniqueness enforced, RLS blocks anon direct reads, public reward function
  returns only the D7 allowlist, no key material in any public shape.

**Manual verification:** local Supabase migration applies; `supabase status` /
psql shows the 5 tables; public function call returns the allowlist.

**Failure cases:** migration conflicts with existing tables (must be additive,
no ALTER of existing rows); duplicate migration ids.

**Acceptance criteria:** migration applies cleanly on local; all CHECK/unique/
RLS contract tests pass; typecheck passes; no existing table altered.

**Commit boundary:** `feat(v2b2): add reward domain contracts and migration`
**Local Supabase only:** yes. **Hosted-rollout prohibition:** explicit.

---

### V2B.2.2 — Campaign vault/key infrastructure (custody)

**Goal:** Implement the server-side per-campaign vault key generation,
encryption at rest, and the sign-and-drop broadcast boundary. **Mandatory
Slice 0 spike first** (verify `@nimiq/core` keypair → sign basic tx → RPC
`sendTransaction` → observe).

**Likely files/modules:**
- `src/lib/rewards/vault-key.ts` (new): `generateVaultKeypair`,
  `encryptVaultKey`, `decryptVaultKey`, `signVaultTxAndBroadcast`
  (sign-and-drop; never returns the key).
- `src/lib/nimiq/rpc.ts` (extend): add `sendTransaction` RPC method
  (genuine basic transfer; keep `getTransactionByHash` as the observation path).
- `src/lib/rewards/constants.ts`: master-key source wiring
  (`REWARD_VAULT_MASTER_KEY` server env).

**Schema/RPC work:** none new (key reference column already in V2B.2.1);
a `key_generation` service-side routine only.

**Invariants introduced (design spec §6.1):**
- Key never stored plaintext; encrypted at rest with server-only master key.
- Key never in logs, API responses, browser, or public RPCs.
- One keypair per campaign; decryption transient inside payout/refund boundary.

**Tests BEFORE/with implementation:**
- Round-trip decrypt(encrypt(k)) === k.
- Contract test: stored `vault_key_ref` blob is not the raw key.
- Contract test: no key field in any API/response shape.
- Sign-and-drop: key unreachable after signing returns.
- Broadcast-failure separation: signing valid even when RPC fails.

**Manual verification:** generate → fund address on testnet → broadcast → observe.

**Failure cases:** master key missing/misconfigured (fail closed); RPC broadcast
not available on the configured Nimiq node; key generation entropy issues.

**Acceptance criteria:** spike passes (server can broadcast a basic NIM tx);
all key-boundary tests pass; no key leaks.

**Commit boundary:** `feat(v2b2): add reward vault key infrastructure`
**Local Supabase only:** yes. **Hosted-rollout prohibition:** explicit.

---

### V2B.2.3 — Creator reward configuration

**Goal:** Let the creator configure reward terms during create; store the
`configured` campaign; enforce D6 minimum and D9 fee-reserve sizing.

**Likely files/modules:**
- `src/app/create/page.tsx` (extend): reward configuration step/fields
  (reward per participant, max participants) + draft persistence extension.
- `src/lib/drafts/types.ts` / `src/lib/drafts/storage.ts` (extend): reward
  fields in the draft.
- `src/lib/rewards/config.ts` (new): validation + fee-reserve formula
  (`feeReserveLuna = estimatedFee × max × safety`), immutable-terms guard.
- `src/app/api/polls/publish/route.ts` (extend): accept/validate reward config;
  create `configured` campaign; return `reward_funding_required` when not
  funded.

**Schema/RPC work:** campaign create/update RPC (creator session; terms mutable
only while `configured`/unreserved — D10 boundary).

**Invariants introduced:**
- `reward_per_participant_luna >= MIN_REWARD_PER_PARTICIPANT_LUNA` (D6).
- Terms immutable once `first_reservation_at` set (D10).
- `configured` campaign never advertised as rewarded.

**Tests BEFORE/with implementation:**
- `v2b2-config-test.ts`: min reward rejected; fee reserve formula; create
  campaign idempotent; publish gated (`reward_funding_required`); creator-only
  mutation; D10 immutability after reservation.

**Manual verification:** create a rewarded poll as a draft; inspect campaign row.

**Failure cases:** reward config on private poll (rejected, D2); config change
after reservation (rejected); publish without funding (gated).

**Acceptance criteria:** create flow produces a `configured` campaign; publish
correctly gated; D6/D10 enforced server-side.

**Commit boundary:** `feat(v2b2): add reward campaign configuration`
**Local Supabase only:** yes. **Hosted-rollout prohibition:** explicit.

---

### V2B.2.4 — Nimiq Pay campaign funding

**Goal:** Creator funds the vault via Nimiq Pay; funding intent is created and
the client drives the transaction.

**Likely files/modules:**
- `src/app/api/polls/[pollId]/reward/funding/intents/route.ts` (new):
  creator-session intent creation (`submitted`, reference, amount =
  principal + fee reserve).
- `src/app/api/polls/[pollId]/reward/funding/confirm/route.ts` (new):
  bind → observe → atomic confirm (V2B.2.1 RPC #1).
- `src/components/creator/RewardFundingPanel.tsx` (new): funding UI reusing
  `provider.sendBasicTransactionWithData` (pattern from PollNimSupportPanel).
- `src/lib/support/pending.ts`-style local resume record for funding.

**Schema/RPC work:** funding intent insert; bind; confirm (RPC #1).

**Invariants introduced:**
- Funding is chain-verified (recipient = vault, amount ≥ total, memo,
  networkId, executionResult) — never client-callback truth.
- Over-funding → `refundable_excess_luna` (D5), terms unchanged.
- Duplicate/underfunded attempts rejected (`funding_mismatch`).

**Tests BEFORE/with implementation:**
- `v2b2-funding-test.ts`: happy-path confirm; underfunded rejected;
  over-funded → excess + capacity unchanged; replay idempotent; wrong
  recipient/memo rejected; 401 without creator session.

**Manual verification:** fund a real testnet vault via Nimiq Pay; observe
transition to `funded`.

**Failure cases:** funding broadcast not confirmed (resume via pending record);
funding rejected in Nimiq Pay (clean state); deadline expiry.

**Acceptance criteria:** funding pipeline completes to `funded` only via chain
truth; D5 overpayment handled; replay-safe.

**Commit boundary:** `feat(v2b2): add Nimiq Pay campaign funding`
**Local Supabase only:** yes (local RPC/Nimiq node). **Hosted-rollout
prohibition:** explicit.

---

### V2B.2.5 — Chain funding observation / reconciliation

**Goal:** Robust observation + retry for funding confirmations; reconcile from
chain when a callback/response is lost.

**Likely files/modules:**
- `src/lib/rewards/reconcile.ts` (new): funding observation loop (mirrors the
  support confirm polling with backoff), deadline handling.
- Funding confirm route: `202 pending` + `retryAfterMs` pattern (support
  precedent).

**Schema/RPC work:** none new (uses RPC #1); possibly a
`find_submitted_funding` read function for the reconciliation job.

**Invariants introduced:**
- `INTENT → BROADCAST → CHAIN OBSERVATION → DB CONFIRMATION` ordering.
- Confirmed-but-missed funding is caught by re-observation.

**Tests BEFORE/with implementation:**
- `v2b2-reconcile-test.ts`: hash not yet on chain → pending; later confirm;
  duplicate observation idempotent; deadline expiry → expired.

**Manual verification:** simulate delayed inclusion; observe the poll flips to
rewarded only after confirm.

**Failure cases:** node unavailable; timeout; hash never appears.

**Acceptance criteria:** funding always confirms via chain truth; no state
change from a stale client.

**Commit boundary:** `feat(v2b2): add funding reconciliation`
**Local Supabase only:** yes. **Hosted-rollout prohibition:** explicit.

---

### V2B.2.6 — Atomic reward eligibility / reservation

**Goal:** Fuse reward eligibility into the vote transaction; enforce D1 (creator
excluded), D2 (public only), first-N-until-cap, and D10 `first_reservation_at`.

**Likely files/modules:**
- `src/app/api/polls/[pollId]/vote/route.ts` (extend): after
  `cast_poll_vote_atomic` success, call the campaign reservation RPC.
- `claim_reward_receipt_atomic` (V2B.2.1 RPC #2) — the financial boundary.
- `src/lib/rewards/eligibility.ts` (new): pure eligibility helper (wallet not
  creator, campaign funded, capacity, public poll).

**Schema/RPC work:** reservation RPC (RPC #2) with campaign advisory lock.

**Invariants introduced:**
- One reward max per wallet per campaign.
- Cap boundary atomic — exactly one winner.
- Creator not eligible (D1); private polls never rewarded (D2).
- `first_reservation_at` set on first reservation; terms immutable after (D10).

**Tests BEFORE/with implementation:**
- `v2b2-eligibility-test.ts`: concurrent last-slot race → one winner; creator
  excluded but vote still recorded; private poll no receipt; late vote past cap
  → exhausted, free participation; replay returns same receipt; duplicate
  vote (different option) blocked by existing uniqueness.

**Manual verification:** two-device simultaneous vote at cap boundary.

**Failure cases:** campaign unfunded at vote time (no reward, normal vote);
race at final slot.

**Acceptance criteria:** eligibility is atomic, cap-exact, and D1/D2/D10
enforced; voting power unchanged.

**Commit boundary:** `feat(v2b2): add atomic reward eligibility`
**Local Supabase only:** yes. **Hosted-rollout prohibition:** explicit.

---

### V2B.2.7 — Automatic payout engine

**Goal:** After a receipt is reserved, automatically sign + broadcast the vault
→ participant payout; drive the receipt to `paid` on chain confirmation.

**Likely files/modules:**
- `src/lib/rewards/payout.ts` (new): the payout pipeline — decrypt key
  transiently, sign, broadcast (`sendTransaction`), record attempt, observe.
- `begin_reward_payout_atomic` / `confirm_reward_payout_atomic` (RPCs #3/#4).
- Trigger/hook: invoke payout after reservation (in the vote handler after RPC
  #2) or a bounded worker.

**Schema/RPC work:** payout attempt insert; confirm transition (RPCs #3/#4).

**Invariants introduced:**
- Receipt reaches `paid` only on confirmed hash.
- Participant receives the exact advertised reward (no fee deduction, D9).
- Fee spent tracked in `fee_spent_luna`; broadcast gated on fee coverage.
- Payout hash partial-unique (one hash used once).

**Tests BEFORE/with implementation:**
- `v2b2-payout-test.ts`: happy path → paid; fee deducted from reserve not
  principal; insufficient fee reserve → `fee_reserve_insufficient` + retryable;
  duplicate observation idempotent; exact-reward assertion.

**Manual verification:** real payout from a testnet vault to a participant;
balance confirms.

**Failure cases:** A–G from §0.3.

**Acceptance criteria:** automatic payout is chain-confirmed, exact-amount,
fee-covered, idempotent.

**Commit boundary:** `feat(v2b2): add automatic payout engine`
**Local Supabase only:** yes. **Hosted-rollout prohibition:** explicit.

---

### V2B.2.8 — Payout reconciliation / retry

**Goal:** Reconcile payouts from chain; retry `retryable` receipts with bounded
attempts; surface `fee_reserve_insufficient` for creator top-up (D9).

**Likely files/modules:**
- `src/lib/rewards/reconcile.ts` (extend): payout observation loop + retry
  scheduling.
- `retry_reward_payout_atomic` (RPC #5).
- `GET /api/me/rewards` and creator payout-failures view.

**Schema/RPC work:** retry RPC; a `list_retryable_receipts` read function.

**Invariants introduced:**
- Bounded retries; final-failed receipts excluded from refund math correctly.
- Confirmed-but-missed payouts caught by re-observation.
- Fee reserve exhaustion is a surfaced, actionable state (not silent).

**Tests BEFORE/with implementation:**
- `v2b2-retry-test.ts`: simulated cases A–G; attempt cap; `fee_reserve_insufficient`
  surfaces; retry succeeds; no double pay.

**Manual verification:** kill a worker mid-broadcast; observe reconciliation
recovers without double payout.

**Failure cases:** permanent failure (final-failed); node downtime.

**Acceptance criteria:** reconciliation is chain-truth idempotent; retries
bounded; no double pay.

**Commit boundary:** `feat(v2b2): add payout reconciliation and retry`
**Local Supabase only:** yes. **Hosted-rollout prohibition:** explicit.

---

### V2B.2.9 — Rewarded poll participant UX

**Goal:** Truthful rewarded-poll surface for participants: badge, remaining
count, exhausted state, "You earned" + reward receipt page. No reward CTA on
unfunded campaigns (Safety rule 3). D7 transparency.

**Likely files/modules:**
- `src/components/poll/RewardBanner.tsx` (new): Earn NIM badge + remaining +
  funded/exhausted chip (NIM Blue, text+icon, never colour alone).
- `src/components/poll/PollPageView.tsx` (extend): render reward surface.
- `src/app/polls/[pollId]/reward/[receiptId]/page.tsx` (new): reward receipt
  page (wallet, poll, amount, tx hash, no option).
- `src/lib/rewards/public.ts` (new): public campaign surface query (RPC).

**Schema/RPC work:** `get_public_reward_campaign` (already in V2B.2.1).

**Invariants introduced:**
- Public rewardsRemaining derived from receipts, never a client counter.
- Reward receipt proves wallet+poll+amount, never option.

**Tests BEFORE/with implementation:**
- `v2b2-public-ux-test.ts`: unfunded → no reward CTA; funded → badge shows
  exact offer; exhausted → "rewards exhausted"; receipt page fields; no
  option/choice anywhere; no key material.

**Manual verification:** device + desktop pass of the rewarded poll page.

**Failure cases:** campaign state races with poll status.

**Acceptance criteria:** truthful, privacy-clean, no fake CTA.

**Commit boundary:** `feat(v2b2): add rewarded poll participant UX`
**Local Supabase only:** yes. **Hosted-rollout prohibition:** explicit.

---

### V2B.2.10 — Explore Earn NIM integration

**Goal:** Additive Explore additions: rewarded filter, reward badge/amount on
cards, compact "Earn NIM" section. No sorting/leaderboard/redesign (D8).

**Likely files/modules:**
- `src/lib/explore/types.ts` (extend): `ExploreFilterState.rewarded`,
  `PollCardData.rewarded` + `rewardPerParticipantLuna`.
- `src/lib/data/explore-queries.ts` (extend): rewarded filter (`EXISTS
  reward_campaigns ... status IN ('funded','rewarding')`).
- `src/components/explore/ExploreToolbar.tsx` (extend): rewarded toggle.
- `src/components/product/PollCard.tsx` (extend): reward badge/amount.
- `src/components/explore/EarnNimSection.tsx` (new): compact bounded strip.

**Schema/RPC work:** none new (public campaign query used for the section).

**Invariants introduced:**
- Rewarded filter additive; absent filter → today's behaviour.
- No reward sort/leaderboard; V2A pagination/search semantics intact.

**Tests BEFORE/with implementation:**
- `v2b2-explore-test.ts`: rewarded filter returns funded/rewarding only;
  badge shows exact amount; compact section bounded; existing V2A filter/search/
  pagination suites unchanged (re-run v2a7* suites).

**Manual verification:** Explore on device shows filter + badge + section.

**Failure cases:** none material (additive).

**Acceptance criteria:** additive discovery path; V2A suites still green.

**Commit boundary:** `feat(v2b2): integrate rewards into Explore`
**Local Supabase only:** yes. **Hosted-rollout prohibition:** explicit.

---

### V2B.2.11 — Creator reward management + refunds

**Goal:** Creator surface to inspect funding/payouts/refunds and explicitly
initiate close + refund (D4) or pre-reservation cancel (D10).

**Likely files/modules:**
- `src/app/my-polls/[pollId]/rewards/page.tsx` (new) + view component.
- `src/app/api/polls/[pollId]/reward/refund/route.ts` (new): explicit refund
  initiation (RPC #7).
- Refund confirmation route (RPC #8) + observation.
- `src/lib/rewards/refund.ts` (new): remainder computation
  (principal + fee reserve + excess − paid − fees), D4 gating.

**Schema/RPC work:** close (RPC #6), refund initiate (RPC #7), refund confirm
(RPC #8).

**Invariants introduced:**
- Refund only when campaign closed/cancelled per policy AND no unresolved
  reserved/payout_pending/retryable rewards (D4).
- No automatic timed refund.
- Refund destination = immutable `creator_wallet`.
- Cancel allowed only before `first_reservation_at` (D10).

**Tests BEFORE/with implementation:**
- `v2b2-refund-test.ts`: refund blocked while payouts pending; explicit-only
  (no auto); remainder = principal+fee+excess−paid−fees; idempotent; creator
  only; cancel-before-reservation recovers funds; cancel-after-reservation
  rejected; refund proof fields.

**Manual verification:** creator closes a poll, reconciles, initiates refund,
observes confirmation.

**Failure cases:** refund races with a retrying payout (blocked); fee reserve
insufficient for the refund tx.

**Acceptance criteria:** D4/D10 enforced; remainder exact; idempotent; provable.

**Commit boundary:** `feat(v2b2): add creator reward management and refunds`
**Local Supabase only:** yes. **Hosted-rollout prohibition:** explicit.

---

### V2B.2.12 — Profile NIM-earned integration

**Goal:** Replace `nimEarnedLuna = '0'` with confirmed paid reward accounting.
Count **paid only**; never eligible/reserved/pending/failed. Add `reward`
activity kind with no option leakage.

**Likely files/modules:**
- Profile RPC `get_participant_public_profile` (extend): `nimEarnedLuna` =
  `SUM(reward_receipts.amount_luna)` where status='paid' (public-polls
  boundary); add `reward` activity rows (poll title + amount, no option).
- `src/lib/profiles/types.ts` / `serialize.ts` (extend): allowlist for
  `{ kind:'reward', pollId, question, amountLuna, at }`.
- `src/components/profile/ProfileStats.tsx` / `RecentActivity.tsx` (extend):
  render earned + reward activity.

**Schema/RPC work:** extend the existing profile function (additive return
shape; existing callers unaffected).

**Invariants introduced:**
- NIM earned counts confirmed paid only.
- Fee reserve/fees never count as earned (D9).
- No chosen-option join anywhere.

**Tests BEFORE/with implementation:**
- `v2b2-profile-test.ts`: eligible/reserved/pending/failed excluded; paid
  included; activity kind `reward` has no option fields; backward-compat
  (wallets with no paid rewards still show truthful 0).

**Manual verification:** profile shows real earned total after a paid reward.

**Failure cases:** none material (additive shape extension).

**Acceptance criteria:** truthful earned accounting; privacy intact; V2B.1
profile suites still green.

**Commit boundary:** `feat(v2b2): integrate rewards into participant profiles`
**Local Supabase only:** yes. **Hosted-rollout prohibition:** explicit.

---

### V2B.2.13 — Privacy / money / backward regression gate

**Goal:** Full regression: all V2B.2 suites + every V2A + V2B.1 suite +
typecheck + lint + build + `git diff --check`. Zero failing tests; no
unexplained assertion-count reduction.

**Regression gates (explicit):**
- one-wallet-one-vote (vote-test, cast_poll_vote_atomic)
- selected-option privacy (v2b1-privacy-test)
- NIM support (support-regression-test, v2a6*)
- profiles (v2b1-profile-test)
- create gate (CreateGate tests)
- onboarding (v2b1-onboarding-test)
- Explore pagination/search (v2a7a–v2a7e)
- My Polls / publish (v2b1-backward-test, publish-test)
- session/wallet-switch safety (client.test, session route.test)
- V2B.2 new suites (v2b2-schema/funding/eligibility/payout/retry/refund/
  public-ux/explore/profile)

**Tests:** run every suite above; `npx tsc --noEmit`; `npm run lint`;
`npm run build`; `git diff --check`. Report warnings; investigate any
assertion-count change.

**Manual verification:** spot-check rewarded poll + profile + Explore on device.

**Failure cases:** any regression → stop, fix only the real regression, rerun
the focused suite, resume.

**Acceptance criteria:** all suites pass; tsc/lint/build green; diff clean.

**Commit boundary:** `test(v2b2): verify reward privacy and money safety`
**Local Supabase only:** yes. **Hosted-rollout prohibition:** explicit.

---

### V2B.2.14 — Physical Nimiq Pay device QA

**Goal:** Physical-device QA of the full rewarded-participation journey inside
Nimiq Pay, mirroring the T12/V2B.1 device QA process. Record in a review doc.

**Manual verification checklist (physical iPhone / Nimiq Pay):**
- create + configure reward; funding via Nimiq Pay; funded badge appears
- rewarded poll badge/remaining/exhausted states; no reward CTA when unfunded
- verify wallet → vote → automatic payout → receipt; participant earns exact
  amount
- creator exclusion (creator votes, no reward); private poll no rewards
- Explore rewarded filter + badge + Earn NIM section
- profile NIM earned updates (paid only)
- creator management: funding state, payouts, refunds, cancel boundary
- no horizontal overflow; keyboard usability; no red runtime overlay
- wallet-switch/session edge behaviour (no reward duplication)

**Tests:** record physical results in
`docs/superpowers/reviews/2026-08-22-v2b2-nimiq-pay-device-qa.md`.

**Manual verification:** full pass on device; document PASS/FAIL per item.

**Failure cases:** any device-only defect → fix in focused commits, retest.

**Acceptance criteria:** device QA passes; review doc records evidence;
#21 explicitly marked HTTPS-retest-required (carried to hosted gate).

**Commit boundary:** `docs(v2b2): record Nimiq Pay device QA`
**Local Supabase only:** yes. **Hosted-rollout prohibition:** explicit.

---

## Rollout / #21

- V2B.2.14 completes the local implementation + local device QA.
- **T12 #21** (same-wallet reconnect/session restore, HTTPS retest) is an
  **independent prerequisite** in the later hosted/deployment gate. It is not
  part of any V2B.2 checkpoint.
- After all checkpoints: review hosted-migration prerequisites (including the
  known local ledger discrepancy for `20260805000000_drop_obsolete_confirm_overload.sql`)
  before any hosted rollout — still out of scope here.

## Final Gate (after all checkpoints)

- All V2B.2 suites + all V2A/V2B.1 suites green (zero failures).
- `npx tsc --noEmit` 0 errors; `npm run lint` 0 errors (report warnings);
  `npm run build` PASS; `git diff --check` clean.
- No unexplained assertion-count reduction.
- Device QA recorded; #21 carried to hosted gate.
- No hosted Supabase, no deploy, no merge to main.
