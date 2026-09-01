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

---

## Current V2B.2 status and immediate sequence (2026-09-01)

The V2B.2 Poll roadmap above is preserved in full. This status addendum does
not renumber, replace, or redesign any V2B.2 checkpoint. The current unfinished
Poll work remains the immediate prerequisite for Campaign work.

The known blocker remains:

- `/api/me/polls` succeeds;
- creator reward management / reward-config lookup produces an incorrect 404
  or state;
- an already connected creator is incorrectly told: "Connect your wallet to
  manage this poll."

The active remaining sequence is:

1. **V2B.2.4** — Creator funding initiation / management bug resolution.
2. **V2B.2.5** — On-chain funding observation + reconciliation.
3. **V2B.2.6** — Atomic eligibility + reward reservation.
4. **V2B.2.7** — Automatic vault payout.
5. **V2B.2.8** — Payout reconciliation + retries + durable idempotency.
6. **V2B.2.9** — Rewarded poll participant UX.
7. **V2B.2.10** — Earn NIM discovery.
8. **V2B.2.11** — Creator reward/refund management.
9. **V2B.2.12** — Profile NIM earned.
10. **V2B.2.13** — Privacy / money / backward compatibility gate.
11. **V2B.2.14** — Full physical Nimiq Pay QA.

V2C implementation must not begin until this sequence is respected. Remaining
Poll UX and profile work may continue alongside V2C only after the shared
financial engine is proven.

---

# V2C — Campaigns

Votum is a verified participation network with two separate first-class
product surfaces:

- **Polls** let communities ask people to participate in decisions.
- **Campaigns** let communities, projects and creators activate and reward
  people using NIM.

These are separate UX surfaces. They may reuse shared identity and financial
infrastructure where technically appropriate, but Campaign concepts must not
be used to rebuild or merge Poll creation.

Navigation and product actions eventually preserve:

- Browse Polls;
- Create Poll;
- Create Campaign.

Create Poll is not renamed to Create and is not merged with Create Campaign.

NIM Drop is part of Campaigns. Cashlinks are rejected for this direction.

## Campaign custody direction

The accepted MVP architecture is a dedicated native NIM vault for every
Campaign. Each Campaign receives an isolated Nimiq address/keypair:

```text
Creator Wallet -> Campaign Vault
Campaign Vault -> Participant Wallet
Campaign Vault -> Creator/Funder Wallet (refund)
```

Campaign custody is temporary and Votum-controlled. It is custodial and must
never be called non-custodial. Existing per-reward-campaign encrypted-key
architecture should be reused and generalized only where the readiness audit
proves that it is actually shared.

Architecture Spike #2 is an accepted technical premise for this roadmap. On
Nimiq TestAlbatross it physically proved Campaign wallet generation, native
funding, server-signed native payout, an exact 5 NIM claimant receipt, the
remaining 15 NIM refund, the Campaign balance reaching zero, RPC transaction
retrieval, and `executionResult: true`.

The spike also proved that a submitted transaction hash is not transaction
success: one submitted hash later returned `Transaction not found`. Every
Campaign funding, payout and refund flow therefore requires transaction
observation, reconciliation and finality awareness. A broadcast hash is never
surfaced as Paid or Confirmed by itself.

## V2C.0 — Campaign Integration Readiness Audit

**Timing:** before any Campaign implementation.

Audit the actual Votum codebase and produce a map of the existing boundaries,
callers, state transitions, authorization checks, and public shapes for:

- reward Campaign schema;
- vault schema;
- vault generation;
- encrypted key storage;
- funding requirements;
- funding initiation;
- funding transaction storage;
- funding reconciliation;
- reward receipt model;
- payout code;
- payout reconciliation;
- wallet verification;
- session auth;
- creator authorization;
- profile accounting;
- refund architecture;
- routing;
- APIs;
- discovery surfaces.

The audit must answer, with file and database/RPC references:

1. What is already generic enough?
2. What is tightly coupled to `poll_id`?
3. What should become shared infrastructure?
4. What must remain poll-specific?
5. Should Poll rewards and standalone Campaigns share a base financial entity?
6. What additive schema work is required?
7. How can existing rewarded Polls remain untouched?
8. What should not be generalized?

The audit is a readiness gate, not permission for a giant refactor. No Campaign
implementation, schema change, migration, or legacy Poll reinterpretation is
part of V2C.0.

## V2C.1 — Shared Financial Engine Generalization

After V2C.0, generalize only proven reusable components:

- vault generation;
- vault encryption and storage;
- funding requirements;
- funding initiation;
- funding observation and reconciliation;
- transaction lifecycle;
- payout signing;
- serialized per-vault transaction queue;
- durable payout idempotency;
- payout reconciliation;
- refund lifecycle.

Poll eligibility remains poll-specific. Campaign eligibility remains
Campaign-specific. Existing rewarded Polls must continue to work without being
migrated into Campaigns. Shared infrastructure must be additive and must not
hide or merge the separate UX models.

## V2C.2 — Create Campaign

Add a separate first-class Create Campaign experience while preserving Create
Poll. The Campaign type selector must support:

- Giveaway;
- Secret Drop;
- Private Drop;
- Event Drop;
- Community Reward.

Do not rename Create Poll to Create, merge Poll and Campaign creation into one
wizard, or rebuild Poll creation around Campaign concepts. All five types must
become real supported flows; do not ship fake cards or placeholders for
unsupported types.

## V2C.3 — Public Giveaway

Complete lifecycle:

```text
Creator: create -> configure -> review -> publish -> fund -> confirm active
Participant: open -> verify -> claim -> reserve -> payout -> confirm
Creator: monitor -> exhaust/expire -> reconcile -> refund -> close
```

Requirements:

- one wallet = one claim;
- creator cannot self-claim by default;
- creator-funded principal and fee reserve are explicit;
- claim capacity is reserved atomically;
- payout reaches a confirmed/final state only from observed chain truth;
- physical Nimiq Pay QA is required.

## V2C.4 — Secret Drop

Eligibility is established by a secure Campaign-bound code.

Requirements:

- store a secure hash rather than plaintext where avoidable;
- rate-limit code attempts;
- return a generic invalid-code response;
- bind the code claim to the Campaign;
- prevent replay;
- enforce one-wallet uniqueness;
- complete the same reservation, payout and reconciliation path as other
  claim-style Campaigns.

## V2C.5 — Private Drop

Eligibility is established by a wallet allowlist.

Requirements:

- creator input/import;
- canonical address normalization;
- server-authoritative allowlist checks;
- deterministic duplicate handling;
- privacy review for allowlist data and responses;
- complete funding, claim, payout, reconciliation, refund and closure
  lifecycle.

## V2C.6 — Event Drop

Support an event-oriented Campaign path with:

- Campaign URL;
- QR representation;
- Nimiq Pay deep link where actually supported;
- activation/event code;
- expiry;
- one-wallet rule;
- capacity;
- physical-device QA.

Do not assume a special Nimiq Pay native scanner API without current proof.
QR and deep-link behaviour must be verified on the target physical device.

## V2C.7 — Community Reward

Support a community/contributor reward workflow using the shared Campaign
engine and allowlist strategy where appropriate. Do not invent external
contributor integrations before the core flow works. Eligibility, claim,
reservation, payout, reconciliation, refund and closure must use the same
financial safety boundaries as the other Campaign types.

## V2C.8 — Campaign Management

The eventual creator dashboard/surface should show:

- type;
- status;
- vault;
- principal;
- fee reserve;
- total funded;
- rewarded wallets;
- capacity remaining;
- amount distributed;
- pending payouts;
- failures;
- current balance;
- expiry;
- refundable amount;
- refund state;
- Campaign link;
- transaction proof.

Valid creator actions should eventually include:

- fund;
- complete funding;
- retry permitted failures;
- close;
- request refund;
- share;
- copy Campaign code;
- QR/share tools.

Every management figure and action must be authorized against the creator or
funder identity and must reflect the durable financial state.

## V2C.9 — Campaign Discovery

Add discovery deliberately without damaging Browse Polls. A possible additive
surface is `/campaigns`, with Browse Campaigns and/or an Active Campaigns
section.

Useful information may include:

- Campaign type;
- creator or project;
- reward;
- remaining capacity;
- expiry.

Do not rank the product around the highest payout. Avoid casino-like cards,
countdowns, language, or presentation. Poll discovery and Campaign discovery
remain distinguishable surfaces.

## V2C.10 — Proof of Campaign

Public proof must truthfully expose only what Nimiq and the Votum ledger can
prove:

- Campaign wallet;
- funding transaction;
- funded amount;
- payout transactions;
- amount distributed;
- remaining balance;
- refund transaction;
- refunded amount;
- status.

Chain data does not prove unique humans, the off-chain reason for eligibility,
Secret Drop code entry, or identity beyond wallet ownership. Public proof must
not claim those things.

## V2C.11 — Refund + Closure Hardening

Test at minimum:

- expiry with no claims;
- partial claims;
- exhausted Campaign;
- overpayment;
- underpayment;
- pending payout at expiry;
- failed payout;
- accidental duplicate funding;
- unsolicited NIM;
- refund;
- final zero-balance close where expected.

Refund must be blocked while unresolved obligations exist, including reserved,
payout-pending, retryable, or otherwise unresolved financial states. Closure,
refund reservation, refund broadcast, observation, and final confirmation must
be separately represented and reconciled.

## V2C.12 — Security Gate

Before Campaign release, audit:

- vault isolation;
- key encryption;
- master-key assumptions;
- future signer/HSM boundary;
- authentication;
- replay prevention;
- race conditions;
- atomic reservation;
- payout idempotency;
- serialized per-vault queue;
- transaction finality;
- network mismatch;
- amount mismatch;
- creator self-claim;
- allowlists;
- Secret Drop brute force;
- refund authorization;
- logs and secrets;
- financial-state truthfulness.

The gate must demonstrate that no client callback, submitted hash, stale read,
or unauthenticated request can create a false financial state.

## V2C.13 — Full Physical Nimiq Pay E2E

Run full physical Nimiq Pay E2E for all five Campaign types:

- Giveaway: creator create/fund -> participant claim/receive -> creator
  reconcile/refund;
- Secret Drop: enter code -> claim -> receive;
- Private Drop: eligible wallet accepted -> ineligible wallet rejected;
- Event Drop: QR/deep link -> Nimiq Pay -> claim;
- Community Reward: eligible member -> claim -> receive.

Every UI financial status must be checked against actual chain state. Device QA
must cover cancellation, retry, expiry, wallet switching, capacity, and proof
surfaces where applicable. Do not mark a Campaign paid from a broadcast hash
alone.

## Campaign Claim Model

Claim-style Campaigns follow:

```text
eligible -> reserved -> payout_pending -> broadcast -> observed/executed -> confirmed/final
```

Appropriate failure states include:

- failed;
- retryable;
- rejected;
- released/expired.

`broadcast` is an operational lifecycle state, not proof of payment. A receipt
is not Paid until the stored transaction is observed as executed and confirmed
under the configured network/finality policy.

## Atomic Claim Guarantee

One wallet equals one Campaign claim unless a future Campaign type explicitly
changes the rule. This means wallet uniqueness, not human uniqueness.

Use a durable uniqueness constraint equivalent to:

```sql
UNIQUE(campaign_id, canonical_wallet)
```

Claim capacity must be reserved transactionally. If one reward remains and 100
requests race, exactly one request may reserve it. The losing requests must
receive a truthful ineligible/exhausted result and cannot create a payout.

## Payout Idempotency

Persist durable payout intent and state before or at the signing/broadcast
boundary. Broadcasting and then losing the HTTP response must not allow a
retry to send a second reward. A retry must reconcile the previous attempt and
its stored hash before creating another spend. Unique attempt identity,
guarded transitions, and chain observation must make duplicate workers safe.

## Per-Vault Queue

Spends from the same Campaign vault must be serialized or use an equivalent
account-state-safe design:

```text
Campaign A: payout 1 -> payout 2 -> payout 3
Campaign B: may process independently
```

Unrelated workers must not concurrently spend the same vault without a
serialized transaction queue, nonce/account-state coordination, or an equally
strong proven mechanism.

## Reward Economics

The creator defines:

- reward per recipient;
- maximum recipients.

The server derives:

```text
principal = reward per recipient * maximum recipients
required funding = principal + fee reserve
```

Participants receive the exact advertised reward. The creator/Campaign bears
operational transaction cost. TestAlbatross zero-fee observations must not be
treated as proof of mainnet zero fees; retain the current conservative
fee-reserve model until mainnet economics are deliberately validated.

## Product Guardrails

Votum remains verified participation:

- Polls let communities ask;
- Campaigns let communities activate/reward.

Votum must not become a Galxe clone, quest marketplace, casino, prediction
market, marketing CRM, token-weighted governance product, or random social
platform.

Poll reward behaviour remains:

```text
participate -> automatic reward
```

Ordinary rewarded Polls have no Claim button. Campaign behaviour remains:

```text
open Campaign -> satisfy eligibility -> intentionally claim
```

These UX models must not be merged.

## Legacy Support

Preserve `legacy_support` completely. Do not migrate legacy Polls into
Campaigns, reinterpret historical NIM support as Campaign rewards, or merge
the underlying ledgers. They remain distinct and auditable:

- legacy support;
- Poll participation rewards;
- Campaign rewards.

Profile aggregation can be designed later, but raw ledgers must remain
auditable and their source meaning must remain explicit.

## Long-Term Custody Direction

The isolated Campaign vault is accepted MVP custody, not a permanent product
constraint. Future architecture evaluation should include:

- isolated remote signer;
- HSM;
- KMS;
- MPC/threshold signing;
- policy-restricted signing;
- future Nimiq primitives;
- future native batch/claim distribution.

The product must preserve a future signer boundary rather than locking itself to
ordinary application-server custody.

## V2C Sequencing and Stop Condition

Do not start V2C implementation in this roadmap update. The immediate order is:

1. Integrate this roadmap.
2. Finish V2B.2.4 creator-management/config/auth bug.
3. Build V2B.2.5 funding reconciliation.
4. Build V2B.2.6 atomic reservation.
5. Build V2B.2.7 automatic payout.
6. Build V2B.2.8 reconciliation/retries/idempotency.
7. Run V2C.0 Campaign Integration Readiness Audit against the actual code.
8. Generalize only proven shared infrastructure.
9. Add Create Campaign.
10. Build Giveaway, Secret Drop, Private Drop, Event Drop, and Community
    Reward.
11. Complete Campaign management, discovery, proof, refunds, and security.
12. Run full physical Nimiq Pay E2E.
13. Prepare the submission.

Stop after roadmap integration. No Campaign implementation, schema/migration
work, NIM transfer, deployment, or hosted rollout is part of this document
update.
