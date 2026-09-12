# V2B.2 — Creator-Funded Rewarded Participation (Implementation Plan)

**Status:** V2B.2.8 complete locally; V2B.2.11 Phases A (pure closure/refund
policy), B (atomic refund preparation/freeze), and C (server sign/broadcast)
complete locally; refund confirmation, physical payout QA, and later V2B.2
checkpoints remain pending.
**Date:** 2026-08-22
**Branch:** `feat/v2-participation-record`
**Starting HEAD:** `80288e523422c89c490eac2f1444f76c3ed39f8d`
**Design spec:** `docs/superpowers/specs/2026-08-22-v2b2-rewarded-participation-design.md`
**Locked decisions:** D1–D10 (see design spec §0.1)
**Depends on:** V2A (Explore/publish/vote/support), V2B.1 (verified identities),
and a **mandatory Slice 0 custody spike** (server-side Nimiq signing/broadcast).

> This document plans V2B.2 as small, independently verifiable checkpoints
> (V2B.2.1 … V2B.2.14). Each checkpoint is a commit boundary with its own goal,
> files, invariants, tests, and acceptance criteria. Checkpoint status notes below
> record the work completed so far.

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
| 7 | **Refund preparation** `begin_reward_refund_atomic` | campaign lock | one durable refund intent per campaign; requires no unresolved reserved/payout_pending/retryable (D4) | Compute remainder (principal + fee reserve + excess); freeze refundable amount |
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
| C. DB marks pending, broadcast never occurs | Payout attempt remains recoverable; no receipt reaches `paid` without a confirmed hash; a new attempt is allowed only for a hashless pre-broadcast failure. |
| D. Same payout worker retries | `UNIQUE(receipt_id, attempt_number)` + guarded state; a duplicate attempt returns `replay`/`attempt_exists`. |
| E. Crash between signing and persistence | V2B.2.7 persists the signed bytes/hash before the network call; if that persistence fails, the network call is not made. A stored hash or broadcast-start marker is always reconciled before any retry. |
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

### V2B.2.7 — Automatic payout engine (sign + broadcast only)

**Goal:** After a receipt is reserved, automatically sign + broadcast the exact
vault → participant payout and persist the durable broadcast attempt. This
checkpoint stops at `payout_pending`; a broadcast hash is not proof of payment.

**Likely files/modules:**
- `src/lib/rewards/payout.ts`: authoritative payout runner, durable preparation,
  idempotent replay, and server-only vault signing boundary.
- `src/lib/nimiq/broadcast.ts`: strict server JSON-RPC `sendTransaction` adapter.
- `begin_reward_payout_atomic` plus preparation, broadcast-marker, outcome, and
  campaign-scoped lease-lock RPCs.
- Vote route hook invokes the payout runner after a successful/replayed
  reservation; there is no participant claim button or client signing path.

**Schema/RPC work:** durable prepared transaction/signing metadata, a
  pre-broadcast marker, normalized hash persistence, and a campaign/vault lease.
  Existing attempt states remain unchanged: `pending` covers prepared or
  broadcast-unknown work; `failed`/`retryable` remain existing failure states.

**Invariants introduced:**
- Receipt transitions `reserved → payout_pending` atomically with one active
  payout attempt. This checkpoint never writes `paid`.
- Participant receives the exact advertised reward (no fee deduction, D9).
- The authoritative recipient and integer Luna amount come only from the
  receipt; sender comes only from its campaign vault row.
- The fixed server fee policy and configured network id are used; no browser
  amount, sender, recipient, fee, network, or hash is accepted.
- Signed transaction bytes and deterministic hash are persisted before the
  network call; `broadcast_started_at` is persisted before the call as well.
- A campaign-scoped database lease serializes construction/broadcast for the
  isolated vault while unrelated campaigns proceed independently.
- Payout hash is partial-unique and guarded against reuse across financial
  ledgers.

**Tests BEFORE/with implementation:**
- `src/lib/rewards/payout.test.ts`: deterministic signing/broadcast mocks cover
  authoritative terms, replay, concurrency, failure classification, unknown
  outcomes, option independence, integer Luna, and secret boundaries.
- `src/lib/rewards/payout.db.test.ts`: local PostgreSQL proof covers atomic
  claim, prepared/hash persistence, no `paid` transition, one attempt,
  same-vault serialization, independent vaults, and no refunds.
- `src/lib/nimiq/broadcast.test.ts`: strict send response normalization and
  timeout/rejection/malformed classification.

**Crash-window strategy:** if the process dies after the prepared row is
written, replay uses those exact signed bytes and hash. If it dies after
`broadcast_started_at` is written, replay never sends again, even if the node
response was lost. V2B.2.8 must observe the stored hash and reconcile the
outcome. A definite signing/local failure is marked `retryable` without a
fabricated hash; a timeout, malformed response, or lost post-call persistence
remains `pending` with an unknown outcome.

**Manual verification:** deferred. No real NIM or QA-vault transaction is
allowed before V2B.2.8 reconciliation/finality is complete.

**Acceptance criteria:** durable attempt exists, exact reward is signed and
broadcast server-side, same-vault serialization and duplicate-send protection
are proven, successful broadcast stores a normalized hash and leaves the
receipt `payout_pending`, and no paid/finality/retry reconciliation is started.

**Commit boundary:** `feat(v2b2): broadcast reserved reward payouts`
**Local Supabase only:** yes. **Hosted-rollout prohibition:** explicit.

---

### V2B.2.8 — Payout reconciliation / finality / safe retry boundary

**Status:** Complete locally; no physical NIM payout or hosted rollout.

**Goal:** Reconcile payouts from chain truth and atomically transition only an
exact, executed, canonical, macro-final payout to `paid`. A broadcast hash,
confirmation count, client label, or client-supplied fields are insufficient.

**Likely files/modules:**
- `src/lib/rewards/payout-reconciliation.ts`: server-only context loading,
  observation orchestration, pure decision application, and vault-lease reuse.
- `src/lib/rewards/reconciliation.ts`: exact payout policy added beside the
  existing funding policy; it reuses the existing observation/finality types.
- `src/app/api/polls/[pollId]/reward/payouts/[attemptId]/reconcile/route.ts`:
  participant-authenticated reconcile request with no chain-truth input body.
- `confirm_reward_payout_atomic` (paid transition) and
  `retry_reward_payout_atomic` (safe retry creation gate).

**Schema/RPC work:** payout confirmation metadata for canonical micro-block,
batch, and finalizing macro-block evidence; atomic paid transition; bounded
hashless-pre-broadcast retry gate. No list/job/refund/profile work is included.

**Invariants introduced:**
- Only exact sender, recipient, amount, stored hash, network, successful
  execution, canonical inclusion, and macro finality can produce `paid`.
- Confirmed-but-missed payouts are caught by re-observation of the stored hash.
- `paid_at`/`confirmed_at` and `paid_amount_luna` are written once by one
  security-definer transaction; duplicate confirmation returns `replay`.
- Concurrent reconciliation for one campaign vault cannot double-account.
- Hash-bearing pending/unknown/rejected attempts cannot create a second send.
- A new attempt is permitted only after a definite hashless pre-broadcast
  failure and is bounded by `MAX_PAYOUT_ATTEMPTS` (5).

**Tests BEFORE/with implementation:**
- `src/lib/rewards/payout-reconciliation.test.ts`: 30 deterministic tests for
  exact finality, all exact-field mismatches, execution/finality uncertainty,
  missing/not-found/RPC/malformed observations, idempotency, concurrency,
  no-broadcast/no-option/no-refund boundaries, and retry safety.
- `src/lib/rewards/payout-reconciliation.db.test.ts`: 8 local PostgreSQL tests
  for paid transition/evidence, timestamp/accounting idempotency, concurrent
  confirmation, wrong pairing, not-found safety, no refunds, and the retry
  gate.
- Existing V2B.2.7, reservation, funding confirmation, observation/finality,
  and vault/security suites remain green.

**Manual verification:** deferred until physical Nimiq QA is explicitly allowed.
The local proof uses mocked/deterministic chain observations only.

**Failure cases:** not-found, RPC failure, non-final, reorg/canonical mismatch,
malformed, wrong sender/recipient/network/amount, and execution failure never
mark paid. Hash-bearing failures remain pending/manual-review-compatible because
the current Nimiq semantics do not prove that a fresh spend is safe.

**Acceptance criteria:** canonical/final payout proof works; paid transition is
atomic and idempotent; exact amount is enforced; unknown/not-found/reorg states
remain safe; retry cannot blindly resend; no duplicate payout or refund is made.

**Commit boundary:** `feat(v2b2): reconcile reward payouts onchain`
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

**Phase A status (2026-09-12):** Complete locally; Docker-off and pure. This
phase defines the closure/refund policy only. It does not add RPCs, routes,
database mutations, signing, broadcasting, chain observation, or Campaign
implementation.

- `src/lib/rewards/refund-policy.ts` classifies payout-bearing receipts before
  refund calculation. Reserved, payout-pending, and retryable obligations block
  closure; eligible or terminal failed receipts without payout evidence can
  settle into the remainder. Hash-bearing, non-final, broadcast-started, or
  manual-review payout attempts require reconciliation before funds can be
  released.
- Campaign closure requires a closed participation window and a valid
  `funded`/`rewarding`/`exhausted` lifecycle state. Cancellation is accepted
  only before `first_reservation_at`; `closed` and `refunded` campaigns are
  idempotently rejected.
- Refund accounting uses integer Luna only: unused reward principal, unused fee
  reserve after confirmed spend and protected reserve, and refundable funding
  excess are each counted once. The result is capped at the proven vault
  balance and malformed or negative accounting fails closed.
- `src/lib/rewards/refund-policy.test.ts` contains 23 deterministic tests for
  obligation blocking, payout reconciliation gates, cancellation boundaries,
  exact accounting, vault caps, zero refunds, integer arithmetic, idempotency,
  and option independence.
- **Phase B status (2026-09-12):** Complete locally; no chain execution or
  hosted rollout. `supabase/migrations/20260912040000_v2b2_prepare_reward_refund.sql`
  adds the service-role-only `begin_reward_refund_atomic` boundary, creator
  session authorization via persisted session hash, exact integer-Luna ledger
  checks, one durable campaign refund intent, confirmed-fee accounting, and
  post-freeze campaign/receipt/payout/refund guards. It creates no transaction,
  signing request, broadcast, or chain observation.
- `src/lib/rewards/refund-preparation.db.test.ts` contains 32 local integration
  tests covering closure gates, creator/vault derivation, accounting, fee
  reconciliation, idempotency, concurrency, cancellation, freeze guards, and
  no-chain/no-option boundaries.
- Phase B does not add the HTTP refund route, chain observation, refund
  confirmation, or refund execution; those remain later checkpoints.
- **Phase C status (2026-09-12):** Complete locally; no hosted rollout, real
  NIM transfer, or finality observation. `src/lib/rewards/refund.ts` signs the
  frozen refund from the campaign vault, persists the complete signed
  transaction before the external call, writes the durable broadcast-start
  marker, and persists only a normalized callback hash. It never changes the
  refund out of `pending` or the campaign out of `refunding`.
- `supabase/migrations/20260912050000_v2b2_broadcast_prepared_reward_refunds.sql`
  adds prepared-transaction proof fields, crash-window constraints, service
  role RPCs, and shared campaign-vault locking. Refund execution reuses the
  existing payout lease-release RPC and signing/broadcast primitives.
- `src/app/api/polls/[pollId]/reward/refund/route.ts` is the explicit,
  verified-session creator boundary. It derives the campaign from the poll,
  invokes the Phase B preparation RPC, and then executes only the returned
  refund intent; request bodies cannot override economic terms.
- `src/lib/rewards/refund.test.ts` contains 29 deterministic unit tests for
  authority, prepared-state idempotency, locking, failure classification,
  unknown outcomes, malformed responses, no-final-state behavior, and secret
  boundaries. `src/lib/rewards/refund.db.test.ts` contains 4 local integration
  tests for durable persistence, unknown-outcome idempotency, concurrent
  execution, and refund/payout lease contention.
- The full local suite passes with 44 files and 479 tests; TypeScript, lint, and
  production build also pass. Local schema lint completes without errors; its
  recorded local schema still reports PL/pgSQL warnings, while the final
  migration file removes the two new refund-function unused-variable warnings.

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

### V2B.2.5 Phase A status (2026-09-06)

Phase A is Docker-off and contains only pure, deterministic funding
reconciliation plus a server-side Nimiq canonical-chain/finality observation
boundary:

- `src/lib/rewards/reconciliation.ts` compares server-authoritative expected
  funding with normalized chain observations using integer Luna arithmetic.
- `src/lib/nimiq/observation.ts` fetches an existing transaction by hash and,
  when requested, proves finality without signing or broadcasting and without
  importing vault modules.
- Focused Vitest coverage uses synthetic observations/RPC fixtures only. It
  covers exact finality, pre-macro pending, canonical block mismatches,
  transaction disappearance from a canonical block body, RPC failures,
  failed execution, and unmined transactions.
- The verified policy is: `getTransactionByHash` supplies transaction facts;
  `getLatestBlock` supplies the current main-chain head;
  `getBlockByNumber(blockNumber, true)` is main-chain-only per the official
  RPC interface and must contain the observed transaction hash;
  `getBatchAt(blockNumber)` identifies the batch; `getMacroBlockOf(batch)`
  identifies the batch-finalizing macro-block; and
  `getBlockByNumber(macroHeight, false)` must return a canonical macro block
  with the expected height and batch. Only that combination yields
  `finality: "final"`.
- The current `getTransactionByHash` shape does not include a block hash. If
  an observation does include one, the adapter compares it with the
  canonical block hash. Body membership remains the canonical inclusion
  proof, so a reorg/disappearance never confirms and remains pending.
- No arbitrary confirmation count is used. Mini App SDK confirmation counts
  are not financial truth. Missing macro finality is `not_final` or `unknown`;
  RPC failures are retryable and never confirm.
- Sources verified against installed `@nimiq/core@2.7.2` and
  `@nimiq/mini-app-sdk@0.1.0`, plus the official RPC interface:
  `https://www.nimiq.com/developers/protocol/`,
  `https://raw.githubusercontent.com/nimiq/core-rs-albatross/albatross/rpc-interface/src/blockchain.rs`,
  `https://raw.githubusercontent.com/nimiq/core-rs-albatross/albatross/rpc-interface/src/policy.rs`,
  and `https://raw.githubusercontent.com/nimiq/core-rs-albatross/albatross/rpc-interface/src/types.rs`.

At the time of this Phase A record, V2B.2.5 was **not complete**: Phase B was
still pending for the DB reconciliation RPC, atomic campaign transition, funding
ledger mutation, and real chain integration. No local or hosted Supabase
integration was part of that Phase A status. The Phase B status below supersedes
that pending note.

### V2B.2.5 Phase B status (2026-09-06)

Phase B is locally implemented and remains local-only:

- `supabase/migrations/20260906000000_v2b2_confirm_reward_funding.sql` adds the
  service-role-only `confirm_reward_funding_atomic` RPC. It locks the campaign
  before the funding intent, validates the bound hash, vault snapshot, funding
  terms, and observed integer Luna amount, then atomically marks the funding and
  campaign funded. It creates no receipt, payout, or refund rows.
- `src/lib/rewards/funding-confirmation.ts` loads server-authoritative context,
  observes the stored transaction hash through the existing Nimiq adapter, and
  calls the RPC only after pure reconciliation returns confirmed.
- `POST /api/polls/[pollId]/reward/funding/intents/[intentId]/confirm` derives
  all financial truth server-side and accepts no browser confirmation or amount
  fields.
- The local migration was applied with `npx supabase migration up --local`.
- Phase B boundary and database tests pass: 22 focused tests. The complete
  Vitest suite passes 267 tests across 33 files when run without file-level
  parallelism, which avoids unrelated local-DB contention in vault tests.
- No NIM was sent, no wallet transaction was approved, and no hosted Supabase
  project was accessed.

### V2B.2.6 Phase A status (2026-09-06)

Phase A is Docker-off and pure. It defines the policy only; it does not add a
reservation RPC, alter the database, or change the vote route.

- The participation source of truth is `poll_votes`. Its canonical identity is
  `poll_votes.voter_wallet`, and the existing unique constraint
  `(poll_id, voter_wallet)` preserves one verified vote per wallet. The current
  vote route obtains the wallet from `getVerifiedWalletSession`; verification
  stores the canonical wallet in `wallet_sessions` after the signed challenge.
- Creator identity is `polls.creator_wallet`. The policy compares it with the
  participant wallet and returns `creator_not_reward_eligible` without changing
  or invalidating the creator's committed vote.
- `reward_receipts` already provides the required ledger shape: campaign/poll,
  participant wallet, integer `amount_luna`, and lifecycle statuses including
  `reserved`, `payout_pending`, `paid`, `failed`, and `retryable`. It has no
  selected-option field and already enforces `UNIQUE(campaign_id,
  participant_wallet)`.
- Capacity uses the existing authoritative integer
  `reward_campaigns.rewarded_participant_count` against
  `max_rewarded_participants`; fee reserve, raw vault balance, and client
  counters are excluded. Existing receipt presence returns the authoritative
  idempotent reservation before capacity is evaluated.
- `src/lib/rewards/eligibility.ts` returns deterministic `eligible`,
  `already_reserved`, `no_capacity`, or `ineligible` results. Eligible results
  use the campaign's immutable `reward_per_participant_luna` and request a
  `reserved` receipt; browser-supplied reward amounts are ignored.
- Eligibility is independent of the selected option. The pure regression runs
  the same synthetic participation with option A and option B and receives the
  same result; the result contains no option data.
- `first_reservation_at` is represented as a one-time
  `shouldSetFirstReservationAt` boundary. The future atomic operation must set
  it only when it is NULL and never overwrite it.
- Funding confirmation leaves the campaign in `funded`. The future reservation
  transition is `funded → rewarding`; when the increment reaches the cap, the
  same locked transaction may finish at `exhausted`. `rewarding` accepts later
  reservations; `exhausted` never accepts a new one.
- No new columns or uniqueness indexes appear necessary for Phase B. The
  smallest future financial boundary is the plan's
  `claim_reward_receipt_atomic(_participation_id uuid, _campaign_id uuid)`
  (or equivalently named reservation RPC), deriving wallet, poll, creator, and
  reward terms server-side. It must lock the campaign, validate the committed
  participation and public rewarded poll, apply creator exclusion, replay the
  existing receipt, enforce capacity, insert `reserved`, increment the counter,
  set `first_reservation_at` once, and return the authoritative result.
- At the Phase A capture, the current `/api/polls/[pollId]/vote` route called
  only `cast_poll_vote_atomic`; the Phase B implementation intentionally keeps
  voting and reservation as separate boundaries so a committed valid vote is
  never failed by an unavailable or ineligible reward. The route now calls the
  service-only reservation RPC after a created or same-option replayed vote.
- No payout, signing, broadcasting, vault-key import, or V2C work is included.

### V2B.2.6 Phase B status (2026-09-06)

Phase B is implemented locally and remains local-only:

- `supabase/migrations/20260906010000_v2b2_reserve_participant_reward.sql`
  adds the service-role-only `claim_reward_receipt_atomic` RPC. It locks the
  campaign row, derives the participant wallet and poll/creator identity from
  `poll_votes` and `polls`, replays the existing receipt before capacity, and
  atomically inserts `reserved`, increments the authoritative count, transitions
  `funded → rewarding` or the final slot to `exhausted`, and sets
  `first_reservation_at` once.
- `src/app/api/polls/[pollId]/vote/route.ts` looks up the poll campaign and calls
  reservation after `created` and same-option `replay`. Reservation failures are
  logged but never turn a committed vote into a failed response.
- `src/lib/rewards/reservation.db.test.ts` covers 27 local database cases:
  creator exclusion, public/rewarded eligibility, authoritative amount,
  option independence, replay idempotency, campaign lifecycle, first-reservation
  timestamp, capacity, final-slot concurrency, mismatch validation, and no
  payout/refund side effects.
- The RED test first failed with PostgREST `PGRST202` for the missing RPC. After
  the additive migration, focused reservation tests pass `27/27`.
- The complete suite passes `317/317` across 35 files with
  `npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism`; the single
  fork and disabled file parallelism are required for stable Windows local-DB
  integration runs.
- No NIM was sent, no wallet transaction was approved, and no hosted Supabase
  project was accessed. Payout, signing, broadcasting, refunds, V2B.2.7, and
  V2C remain out of scope.

### V2B.2.8 status (2026-09-12)

V2B.2.8 is implemented locally and remains local-only:

- `src/lib/nimiq/observation.ts` remains the sole chain observation/finality
  adapter. Payout reconciliation reuses its transaction, canonical micro-block,
  batch, and finalizing macro-block evidence; no parallel observer exists.
- `supabase/migrations/20260912020000_v2b2_reconcile_reward_payouts.sql` adds
  confirmation evidence columns and the service-role-only
  `confirm_reward_payout_atomic` RPC. The RPC locks attempt → receipt →
  campaign, verifies their relationship and exact persisted terms, marks the
  attempt `confirmed`, marks the receipt `paid`, increments principal once, and
  returns `replay` without rewriting timestamps on duplicates.
- `supabase/migrations/20260912030000_v2b2_safe_reward_payout_retry.sql` adds
  `retry_reward_payout_atomic`. It refuses all hash-bearing attempts with
  `reconciliation_required`; only a definite hashless pre-broadcast failure
  may create a bounded next attempt.
- `src/lib/rewards/payout-reconciliation.ts` is server-only and provides the
  participant-authenticated reconcile route. It accepts no chain truth from the
  browser and never imports or calls the payout broadcaster.
- RED evidence: the first focused run failed to resolve the missing
  `payout-reconciliation` module. After the minimum implementation, focused
  reconciliation tests pass `30/30` and local DB tests pass `8/8`.
- The Windows-stable full command passes `391/391` across 40 files:
  `npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism`.
  TypeScript, lint, build, and `git diff --check` also pass.
- Execution failure, malformed evidence, reorg/canonical mismatch, not-found,
  unknown, and RPC failure never mark `paid`. Hash-bearing uncertain or failed
  attempts remain pending/manual-review-compatible because current Nimiq
  semantics do not prove a fresh spend is safe. No aggressive automatic retry
  worker is included.
- No NIM was sent, no physical payout QA was performed, and no hosted Supabase
  project was accessed.

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
