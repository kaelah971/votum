# V2B.2 — Creator-Funded Rewarded Participation (Design Spec)

**Status:** Draft — design only. No implementation, no migration, no deployment.
**Date:** 2026-08-22
**Branch:** `feat/v2-participation-record`
**Starting HEAD:** `dc306cd0503848ce58ea1389e781c63e02e2b491` (V2B.1 complete, pushed)
**Depends on:** V2A (Explore, publish, vote, support), V2B.1 (verified identities, profiles, sessions)
**Scope:** Design specification only. An implementation plan is a separate future step.

---

## 0. Product Thesis

Votum is a verified participation network where communities, creators, brands,
organizations and fanbases make stronger decisions — and optionally reward
people who participate with NIM.

**V2B.2 core rule — rewards are for participation, not outcomes:**

> A participant earns for verified participation. They **never** earn more for
> choosing the winning option, choosing the majority option, predicting
> correctly, or influencing an outcome.

Every eligible participant in a reward campaign receives the **same predefined
reward**, regardless of which option they selected.

This must **not** become a prediction market, betting, staking on outcomes,
pooled winner payouts, or outcome-linked rewards. The core voting rule
`ONE VERIFIED WALLET = ONE PARTICIPATION / ONE VOTE` is unchanged.

**Campaign shape (example):**

```
rewardPerParticipant = 0.5 NIM
maxRewardedParticipants = 200
requiredCampaignBudget = 100 NIM   (= 0.5 × 200)
```

The creator pre-funds the budget **before** Votum advertises the poll as
rewarded. Funding flows through Nimiq Pay / NIM.

**Votum must truthfully distinguish, at all times:**

```
configured → funding pending → funded → rewards available → reward exhausted
         → campaign closed → refundable remainder → refunded
```

**No fake reward balances.** Every displayed reward figure is derived from
authoritative records at read time; the profile's `nimEarnedLuna` placeholder
(`0`) is replaced only by confirmed settlement ledger truth (see §12).

---

## 1. Non-Negotiable Safety Rules

1. **Integer-only accounting.** Every stored/accounted money value is integer
   Luna (1 NIM = 100,000 Luna, repo constant `LUNA_PER_NIM`). No float in DB,
   API, or RPC. Decimal NIM exists only at the UI boundary via
   `nimDecimalToLuna` / `lunaToNim` / `formatNimAmount` (`src/lib/nimiq/units.ts`).
2. **Reward is outcome-independent.** Reward amount is fixed per campaign and
   identical for every eligible participant. No option, majority, winner, or
   prediction linkage — anywhere.
3. **No reward CTA on an unfunded campaign.** A poll is advertised as rewarded
   only when its campaign is `funded` and has remaining capacity.
4. **Wallet identity is immutable.** Reward identity = canonical-hex wallet
   (the same anchor as votes/support/profiles). Handles, display names, and
   sessions never change reward identity.
5. **One reward maximum per wallet per campaign.** Enforced by DB uniqueness,
   never by UI counters.
6. **Chain truth over client truth.** Funding, payout, and refund state is
   established by observing confirmed Nimiq transactions (RPC), never by a
   client callback or a broadcast hash alone.
7. **Money transitions are atomic DB operations.** Every balance/receipt
   transition is a single security-definer function body (or guarded by an
   advisory lock + unique constraint) so two users can never take the same
   final reward slot or double-pay.
8. **Never reveal the selected option.** Reward receipts, payout memos, profile
   stats, and activity expose participation and reward amount only — never
   `option_id`/choice.
9. **No fake/mock data.** Reward balances are derived; zero is truthful zero.
10. **Additive only.** Existing V1/V2 polls with no reward campaign behave
    exactly as today.

---

## 2. User Stories

- **Creator:** "I want to pay people to join my decision. I set 0.5 NIM per
  participant for up to 200 people, fund 100 NIM once, and Votum pays each
  participant automatically and truthfully."
- **Participant:** "I see a poll that honestly says 'Earn 0.5 NIM for
  participating'. I verify my wallet, vote once, and receive 0.5 NIM — no
  matter which option I chose."
- **Participant (late):** "If the reward cap was already filled, Votum tells
  me 'rewards exhausted' before I vote, and I can still participate for free."
- **Creator (close):** "After the poll closes, unused reward funds come back to
  me automatically, with a transaction proof."
- **Public:** "I can see on a profile that a wallet earned NIM for
  participating — but never which option they chose."

---

## 3. Creator Flow

```
1. Create poll (existing flow) + configure reward:
     rewardPerParticipant (NIM, ≥ 1 Luna)     → validated via nimDecimalToLuna
     maxRewardedParticipants (int ≥ 1)        → validated server-side
     requiredBudgetLuna = perParticipantLuna × max   (exact bigint product)
2. reward_campaign created in state `configured` (0..1 per poll; poll_id UNIQUE).
3. Publish attempt for a rewarded poll returns reward_funding_required
   (campaign state, vault address, requiredBudgetLuna) until campaign is funded.
4. Creator funds via Nimiq Pay:
     provider.sendBasicTransactionWithData({ recipient: vaultAddress,
        value: budgetLuna (as Number, ≤ MAX_SAFE_INTEGER), data: funding memo })
5. Votum observes the funding tx by hash (RPC), verifies recipient = vault,
   amount = requiredBudgetLuna, memo matches, networkId matches, execution
   result true → campaign becomes `funded`.
6. Only then can the poll be published and advertised as rewarded.
7. Creator manages the campaign from /my-polls/[pollId] (see §11).
8. After the poll closes, any unused remainder is refundable (§7).
```

Decisions resolved in §4.

---

## 4. Reward Campaign Model (Design Question 1)

**Decision: one poll has zero or one reward campaign.** `reward_campaigns.poll_id`
is `UNIQUE`. MVP strongly prefers the simplest safe model; multiple campaigns
per poll add nothing but split-capacity and refund complexity, and would
confuse participants. If multiple reward tiers are ever needed, that is a
later model (e.g., a campaign referencing a poll plus a label), not pre-built.

**Entity fields (see §11 for full schema):**

```
id                        uuid PK
poll_id                   uuid UNIQUE REFERENCES polls(id)
creator_wallet            text NOT NULL        -- canonical hex; immutable owner
reward_per_participant_luna bigint NOT NULL    -- same for every participant
max_rewarded_participants int NOT NULL
total_budget_luna         bigint NOT NULL      -- per × max, CHECK-enforced
asset/currency            text NOT NULL CHECK (= 'NIM')  -- NIM only for MVP
status                    text NOT NULL        -- lifecycle state (below)
funded_amount_luna        bigint NOT NULL DEFAULT 0      -- confirmed funding observed
rewarded_participant_count int NOT NULL DEFAULT 0       -- receipts reserved/paid
paid_amount_luna          bigint NOT NULL DEFAULT 0      -- sum of confirmed payouts
refundable_amount_luna    bigint NOT NULL DEFAULT 0      -- confirmed remainder owed to creator
vault_wallet              text NOT NULL        -- per-campaign vault address (§6)
vault_key_ref             text                 -- encrypted server-side vault key reference (§6)
created_at / funded_at / closed_at / refunded_at timestamptz NULL
updated_at                timestamptz NOT NULL
```

**Campaign lifecycle state machine:**

```
 configured ──(funding confirmed)──► funded ──► rewarding ──► exhausted
      │                                │            │           │
      │                                │            └──► closed ──► refunding ──► refunded
      │                                └───────────────► closed ────┘
      └──► cancelled (before funding; no funds at stake)
```

| From | Event | To | Guard |
|------|-------|----|-------|
| `configured` | funding transaction confirmed (recipient=vault, amount=budget, memo ok) | `funded` | atomic RPC; funding ledger row `confirmed` |
| `configured` | creator cancels | `cancelled` | creator session, no confirmed funding |
| `funded` | first reward receipt reserved/paid | `rewarding` | atomic claim |
| `rewarding` | `rewarded_participant_count = max` | `exhausted` | atomic |
| `rewarding` / `exhausted` | poll status = closed | `closed` | poll close |
| `funded` | poll status = closed (no payouts yet) | `closed` | poll close |
| `closed` | all eligible receipts settled AND remainder > 0 | `refunding` | reconciliation |
| `closed` | all eligible receipts settled AND remainder = 0 | `refunded` | reconciliation |
| `refunding` | refund tx confirmed | `refunded` | atomic; unique refund hash |

State `configured`/`funding_pending` is **never** advertised as rewarded. The
poll can exist as a draft, but publish for a rewarded poll is blocked until
`funded` (§5).

---

## 5. Prepaid Funding (Design Question 2)

**Timing — funding happens before publish, and publishing a rewarded poll is
blocked until funding is confirmed.**

- Reward configuration is captured during create and stored on a `configured`
  campaign attached to the (draft) poll.
- An **unfunded rewarded draft can exist** (draft poll + `configured` campaign),
  but it is never advertised as rewarded and cannot be published as rewarded.
- `POST /api/polls/publish` for a poll with a campaign that is not `funded`
  returns `reward_funding_required` with the funding payload — the client then
  drives the Nimiq Pay funding, and the user retries publish.
- Rationale: the thesis states "fund the budget BEFORE Votum advertises the
  poll as rewarded". Blocking publish keeps the reward advertisement truthful
  by construction and keeps MVP logic simple (no "partially funded live poll").

**Funding transaction lifecycle (mirrors the proven NIM-support
`intent → bind → observe → confirm` pattern):**

```
POST /api/polls/[pollId]/reward/funding/intents     (creator session)
  → funding_tx row `submitted` with unique reference, amount=budget,
    memo="votum-reward:<campaignId>", confirmation_deadline
  → return { vaultAddress, budgetLuna, reference }
client sends tx in Nimiq Pay → hash → 
POST /api/polls/[pollId]/reward/funding/confirm { reference, txHash }
  → bind hash (partial-unique), observe getTransactionByHash,
    verify recipient=vault, amount=budget, memo, networkId, executionResult=true
  → confirm_reward_funding_atomic → campaign `funded`
```

- **Failed/underfunded:** an observed tx that does not match recipient/amount/
  memo is rejected (`funding_mismatch`); the funding row is `rejected`, the
  campaign stays `configured`/`funding_pending`, nothing is credited. No fake
  balance.
- **Duplicate funding attempts:** the funding `reference` is unique; the bound
  `transaction_hash` is partial-unique (one hash reserved by at most one
  funding row). Replays return `replay`/`bound_replay`; a second distinct
  confirmed hash is either credited as overpayment (see below) or rejected —
  see open question OQ-5.
- **Transaction hashes recorded** in the funding ledger row (bound hash,
  confirmed hash, block number, tx timestamp), like
  `nim_contributions.transaction_hash`.
- **Confirmation verified** via RPC `getTransactionByHash` with the exact
  field checks from `src/lib/nimiq/rpc.ts` (hash/from/to present, value ≥ 0,
  `executionResult === true`, `networkId` match, memo decode). Sender is
  **not** matched (consistent with support: Nimiq Pay may fund from any
  account); `initiator_wallet` (session) is recorded separately.
- **Overpayment:** if a confirmed funding amount exceeds `total_budget_luna`,
  the excess is recorded as `funded_amount_luna` up to the budget and the
  remainder is carried as `refundable_amount_luna` at close (never silently
  credited). Open question OQ-5: auto-refund immediately vs at close.

---

## 6. Fund Custody / Settlement Architecture (Design Question 3)

### Evaluation

| Criterion | A. Isolated vault | B. Creator signs every payout | C. Shared treasury | D. Nimiq multisig | E. Cashlinks |
|-----------|-------------------|-------------------------------|--------------------|-------------------|--------------|
| Custody | Votum holds a per-campaign key (disclosed) | Creator holds all keys (zero Votum custody) | Votum holds one key for all campaigns | Distributed (not built in SDK) | Creator/vault signs once; anyone redeems |
| Operational risk | Key storage must be encrypted; single-campaign blast radius | Creator must be online/sign each payout (200 txs!) | Single key = single point of failure for ALL funds | High setup complexity | Link expiry/redeem races |
| Payout automation | High — server signs + broadcasts | Low — needs creator per payout | High | Low | Medium |
| Auditability | Per-campaign ledger + chain | Chain + local records | Internal ledger must reconcile | Chain | Chain + link state |
| Blast radius | **One campaign per key** | Creator's own risk | **All campaigns** | Low | One link |
| Key management | One keypair per campaign, encrypted at rest | None (creator's wallet) | One key, must be highly protected | Complex | Key per batch |
| Demo feasibility | Strong (funding via Nimiq Pay mirrors support) | Poor (creator approval per participant) | Medium | Weak | Medium (no SDK support confirmed) |
| Nimiq Pay fit | Funding reuses existing `sendBasicTransactionWithData`; payout is server broadcast | Every payout opens Nimiq Pay | Same as A | Not in `@nimiq/mini-app-sdk` | Cashlink redemption not in SDK |
| Hackathon judging | Clean "creator-funded, automatic, per-campaign isolated" story | Weak | Sloppy (funds mixed) | Not demoable | Interesting but unproven |
| Later migration path | Straightforward (add HSK/HSM, custody partner) | — | Hard to unbundle | Hard | Possible |

**Repository truth on Nimiq primitives:** the repo has no smart-contract
capability, no multisig, and no cashlink dependency. Available primitives are:
`@nimiq/mini-app-sdk` (`listAccounts`, `sign`, `sendBasicTransaction`,
`sendBasicTransactionWithData` — the last already used by the NIM support
panel), `@nimiq/core` (server-side `KeyPair`, `Address`, `Signature` —
currently used only for signature verification), and the Nimiq RPC adapter
(`src/lib/nimiq/rpc.ts`, today only `getTransactionByHash`, with
`getBlockNumber`/`getBlockByNumber` proven in `rpc-probe.ts`). None of these
imply smart-contract behavior, and the design does **not** claim any.

### Recommendation: **A — Per-campaign isolated reward vault/wallet**

- At campaign creation the server generates a fresh `@nimiq/core` keypair; the
  derived address becomes `vault_wallet`; the private key is encrypted at rest
  (`vault_key_ref`) and never exposed to clients or logs.
- The creator funds the vault from their own Nimiq Pay wallet
  (`sendBasicTransactionWithData`) — the exact interaction already proven by
  NIM support. No custody of the creator's wallet is involved.
- Payouts and refunds are **signed and broadcast server-side** from the vault
  keypair using `@nimiq/core` + the Nimiq RPC (`sendTransaction`), then
  verified by `getTransactionByHash`. This requires adding a `sendTransaction`
  RPC method to `src/lib/nimiq/rpc.ts` (a genuine Nimiq basic-transfer, not a
  smart contract). **Implementation must spike the exact @nimiq/core signing +
  RPC broadcast path first** — the repo has never broadcast from a server key.
- Custody honesty: Votum **does** hold vault keys for the campaign lifetime.
  This is a new, explicit, disclosed responsibility (existing brand copy
  "does not custody funds" refers to the direct support flow and must be
  updated for reward campaigns). Mitigations: per-campaign key, encryption at
  rest, no key export, one-campaign blast radius, documented recovery (see
  §21). A later migration path is HSK/HSM or a custody partner — the per-campaign
  ledger design is unchanged by that.
- **Fallback if custody is unacceptable:** Option B (creator-signed payouts)
  is a thinner, fully non-custodial MVP, at the cost of poor payout UX. It is
  not recommended because 200 payouts = 200 creator approvals.

---

## 7. Reward Eligibility (Design Question 4)

**Foundation (all must hold):**

1. Wallet is verified (valid `votum_session` for that wallet).
2. Participation recorded successfully (`poll_votes` row created for
   `poll_id, voter_wallet`).
3. One reward max per wallet per campaign (DB unique `(campaign_id,
   participant_wallet)`).
4. Reward amount independent of selected option.
5. Campaign is `funded` (or `rewarding`).
6. Remaining capacity > 0.

**First-N-until-cap.** Eligible participants are the first `max` wallets whose
participation is confirmed, ordered by the confirmed participation timestamp.
The **ordering source is the DB** (`poll_votes.created_at` / receipt
`created_at`), never a client counter.

**Race at the final slot.** The reward claim is fused into the vote
transaction (see §13): `cast_poll_vote_atomic` (or a companion
`claim_reward_receipt_atomic` called in the same request under the campaign
advisory lock) checks `rewarded_participant_count < max`, inserts the receipt,
and increments the count — atomically. The DB unique `(campaign_id,
participant_wallet)` + advisory lock guarantee exactly one winner.

**Edge cases:**

| Case | Rule |
|------|------|
| Poll creator participating | Excluded from eligibility (creator's own campaign; avoids self-funding capture). Open question OQ-1. |
| Duplicate sessions / reconnect | No effect — identity is the wallet, not the session. |
| Handle/profile changes | No effect — reward keyed to wallet. |
| Wallet reconnect | No effect; session restore (T12 #21) is an independent prerequisite (§20). |
| Private polls | Reward campaigns are **public-polls only** for MVP (reward requires the public participation boundary). Private participation is never rewarded. OQ-2. |
| Closed polls | No new participation; already-eligible receipts still settle after close. |
| Deleted/hidden polls | Campaign requires an existing public poll; deleted/hidden polls resolve via the poll FK/status and are never advertised. |
| Late votes (cap reached) | Participant still votes (free participation) but is **not** rewarded; campaign is `exhausted`, UI says "rewards exhausted". |
| Cancelled campaigns | Before funding: `cancelled`, no rewards, no funds at stake. After funding but before payouts: full refund. |
| Wallet A participates, then same wallet votes again (different option) | Impossible — `UNIQUE(poll_id, voter_wallet)` already blocks a second vote; replay returns the existing vote and the existing receipt (idempotent). |

**Reward identity is the immutable wallet identity** — the canonical-hex wallet
column, exactly as `poll_votes.voter_wallet`.

---

## 8. Claim vs Automatic Payout (Design Question 5)

### Options

| Criterion | A. Automatic payout | B. Explicit "Claim NIM" | C. Batched settlement | D. Hybrid |
|-----------|---------------------|-------------------------|-----------------------|-----------|
| UX | Zero-friction ("vote → NIM arrives") | User taps Claim | Delay | Mixed |
| Transaction volume | 1 tx per eligible participant (bounded by cap) | Only claimed receipts (fewer txs) | Fewest (batch) | Variable |
| Nimiq Pay visibility | Payout happens server-side; user sees balance change | User re-enters Nimiq Pay to claim | None until arrival | Depends |
| Failure recovery | Retry queue per receipt | Retry on claim | Reconciliation job | Per-path |
| Cost | Pay per participant (creator pays fees) | Fewer payouts → lower fees | Lowest | — |
| Abuse resistance | Reward immediately attached to real participation | Claim adds a hop | Same as A | — |
| Implementation complexity | Low (reuse support confirm loop) | Medium (claim gate + expiry) | High (scheduler) | High |
| Demo strength | **Strong** — "participate and get rewarded" is instant and magical | Good but adds friction | Weak (delay) | — |

**Recommendation: A — automatic payout after confirmed participation.**

- Rationale: the reward is the moment of participation. Automatic payout makes
  the value proposition instant and demoable, eliminates unclaimed-funds
  expiry (no "expired/unclaimed" state for MVP), and reuses the exact
  observe-and-confirm pattern proven in NIM support.
- Implementation: on `cast_poll_vote_atomic` success for a funded campaign
  with capacity, the server claims a receipt (`eligible`), immediately starts
  a payout attempt from the vault, and records the outcome. Failure → the
  receipt stays `retryable` and is retried (see §9).
- The user never reveals their selected option to claim — there is no claim
  action at all; payout is keyed to the wallet + poll only.
- **Open question OQ-3:** confirm automatic vs explicit claim is a genuine
  product choice (cost of 200 payouts, creator fee policy).

---

## 9. Reward Receipts (Design Question 6)

**A truthful reward ledger** with per-wallet lifecycle state:

```
eligible → reserved → payout_pending → paid
                        └──► failed → retryable → payout_pending
```

- `eligible` — participation recorded, capacity available, receipt created
  atomically with the vote.
- `reserved` — the reward slot is taken; balance holds it. (MVP may merge
  `eligible`/`reserved` — kept distinct to make the cap race auditable.)
- `payout_pending` — a payout attempt is in flight (broadcast not yet
  confirmed).
- `paid` — terminal; payout transaction confirmed on chain.
- `failed` — broadcast/observation failed; no funds moved.
- `retryable` — can be retried; unique `(receipt_id, attempt_number)` and the
  guarded `eligible→…→paid` transition mean a receipt can never be paid twice.
- `expired/unclaimed` — **not needed in MVP** (automatic payout; no claim). If
  a claim path is later chosen, this state is added then.

**Uniqueness / idempotency:**

- `reward_receipts`: `UNIQUE (campaign_id, participant_wallet)` — a wallet can
  never receive the same campaign reward twice.
- `reward_payout_attempts`: `UNIQUE (receipt_id, attempt_number)` and the
  payout `transaction_hash` is partial-unique against the whole ledger (one
  hash used once).
- Transitions are guarded security-definer updates: only `eligible`/`reserved`
  → `payout_pending`, only `payout_pending` → `paid` (with a matching
  confirmed hash), etc.

**Receipt proof:** "wallet X participated in poll Y and received Z NIM".
The receipt row joins campaign → poll and stores amount, status, confirmed
payout hash, and timestamps. It stores **no `option_id`** anywhere — the
receipt cannot reveal which option was selected. Payout memos reference the
campaign/receipt, never the option.

---

## 10. Creator Refunds (Design Question 7)

**When the remainder becomes refundable:** after the poll is `closed` and all
eligible receipts are settled (`paid` or terminal `failed` with no retry
pending). Remainder = `funded_amount_luna − paid_amount_luna` (vault balance
truth, reconciled against the refund ledger).

**Who can initiate:** the campaign creator (verified session, wallet must match
`creator_wallet`). Creator wallet changes are **not allowed** to redirect
ownership — identity and refund destination are the immutable
`creator_wallet`.

**Automatic vs explicit:** **explicit refund button** for MVP (a creator
action with a confirm step), executed server-side from the vault; automatic
refund is an open question OQ-4.

**Refund lifecycle:**

```
pending → confirmed | failed → retryable
```

- **Blocked while payouts are pending:** the refund RPC refuses if any receipt
  is in `reserved`/`payout_pending`/`retryable`. Reconciliation first settles
  or finalizes those.
- **Partial payout failures:** failed receipts are retried (up to a bounded
  attempt count) before refund; if a receipt is final-failed (no funds moved),
  its reserved amount is simply not paid and flows into the remainder. No
  over-refund: refund amount is computed from confirmed-paid receipts only.
- **Rounding/dust:** all arithmetic is integer Luna; remainder = paid-total
  subtraction. Dust (< 1 Luna cannot exist by construction). Open question
  OQ-6 on the minimum meaningful reward to avoid dust-y payouts.
- **Transaction proof:** refund rows record the bound/confirmed hash, block,
  timestamp — same observe-and-confirm pattern.
- **Idempotency:** one active refund per campaign; a second refund attempt
  returns `replay`; the refund hash is partial-unique.

---

## 11. Abuse / Sybil Boundary (Design Question 8)

V2B.2 does **not** pretend "verified wallet = unique human".

**MVP protections (built-in):**

- One reward per wallet per campaign (DB unique).
- One vote per wallet per poll (existing `UNIQUE(poll_id, voter_wallet)`).
- Creator self-participation excluded (§7, OQ-1).
- Reward only for real, confirmed participation in a public poll.
- No outcome/majority linkage, so "reward-maximizing" cannot change any
  financial outcome.
- Cap race resolved atomically by the DB; no client-counter trust.
- Funding verified from chain (recipient/amount/memo/networkId), not client
  callback; sender deliberately not required.
- Payouts only from the campaign vault, only to receipt wallets, only while
  funded/within capacity.

**Honest boundary — V2B.2 does NOT prevent:**

- Wallet farming (one person, many wallets) — each farmed wallet participates
  and earns like any other. Votum's identity is "verified wallet", not "unique
  human".
- Many wallets controlled by one person participating normally.
- Scripted participation from many wallets.
- Repeated reconnect/session generation (does not multiply rewards — same
  wallet, same vote, same receipt).
- Funding manipulation of a *single* campaign is bounded by the vault ledger;
  a malicious creator can still create many small campaigns (cost is the NIM
  they commit).
- A creator funding their own campaign is allowed (their money, their vault),
  but they are excluded from their own reward pool.

**Deferred to later identity/reputation layers** (explicitly out of V2B.2):
reputation scoring, social graph, advanced Sybil detection, device/bio
fingerprinting, captcha, referral gates, streaks, leaderboards. V2B.2 is not
identity infrastructure; it must not overbuild.

---

## 12. Public Poll UX (Design Question 9)

**Truthful information shown on a rewarded poll (only when `funded`):**

- "Earn X NIM for participating" — badge in the poll header, using NIM Blue
  (informational/proof), paired with text + icon (never colour alone; DESIGN.md
  rule). Signal Gold remains the single CTA colour.
- "X of N rewards remaining" — derived from the DB (`rewarded_participant_count`
  vs `max`), never a client counter.
- Funding state as a status chip: "Rewards funded" (funded) / "Rewards
  exhausted" (exhausted) / nothing (configured/funding pending — **no reward
  CTA**).
- After participation + payout: "You earned X NIM for participating" with a
  link to the reward receipt (which proves wallet, poll, amount — and no
  option).
- If the user already voted and the receipt is `retryable`: "Your reward is
  being sent — we'll retry."

**What public users see about amounts:**

| Field | Public? | Note |
|-------|---------|------|
| Reward per participant | Yes | It is the campaign's advertised offer. |
| Max participants | Yes | Part of the offer. |
| Rewards remaining | Yes | Count, derived. |
| Exact funded budget | Partial | "Rewards funded" status; exact budget visible to creator only. OQ-7 (public exact budget?) |
| Exact paid amount | No (creator only) | Public sees remaining count, not cumulative payouts. |
| Payout tx IDs | No (receipt page only) | Keeps the page lightweight and clean. |

**No reward CTA on an unfunded campaign** — a hard rule (Safety rule 3). If the
campaign is `configured`/`funding_pending`/`cancelled`, the poll renders as a
normal free poll.

---

## 13. Explore (Design Question 10)

**Minimum V2B.2 additions — no redesign of V2A Explore:**

1. **Rewarded filter** — a binary toggle in the existing filter set
   (`ExploreFilterState.rewarded: boolean`), applied in the server query layer
   (`explore-queries.ts`) as `EXISTS (reward_campaigns WHERE poll_id = polls.id
   AND status IN ('funded','rewarding'))`. Backward compatible: absent →
   today's behaviour.
2. **"Earn NIM" badge on PollCard** — small NIM Blue badge on cards whose
   campaign is `funded`/`rewarding` with capacity. `PollCardData` gains an
   optional `rewarded: boolean` (and optionally `rewardPerParticipantLuna`).
   No new card layout.
3. **Optional sort/group** — a "Rewarded" flat sort or a "Earn NIM" section is
   **not required for MVP**; the filter + badge provide the discovery path.
   OQ-8.

The Explore `PollCardData` contract keeps excluding private fields
(`destinationWallet`, contribution mode, etc.); it adds only the truthful
reward surface (funded + per-participant offer).

---

## 14. Creator UX (Design Question 11)

From `/my-polls/[pollId]` and a new `/my-polls/[pollId]/rewards` surface, the
creator can inspect, all derived from the DB:

- Funding state (`configured` / `funding_pending` / `funded` / …)
- Required budget, funded amount (exact)
- Reward per participant, max participants
- Rewards paid (count + `paid_amount_luna`), rewards remaining (count)
- Payout failures (retryable receipts) with retry action
- Refundable balance and refund action (after close, once payouts settle)
- Refund state + transaction proof

**Immutability:** reward configuration (`reward_per_participant_luna`,
`max_rewarded_participants`, `total_budget_luna`, `vault_wallet`) becomes
**immutable once the campaign is `funded`** (or at first payout). Changing
terms after participants saw the offer would mislead them. The only mutable
fields are lifecycle state and derived balances. Immutability is enforced
server-side in the update RPC (no client-only rule).

---

## 15. Participant Profile (Design Question 12)

Replace the V2B.1 `nimEarnedLuna = '0'` placeholder with **confirmed ledger
truth**:

- **Total NIM earned:** `sum(reward_receipts.amount_luna)` where status =
  `paid` and `participant_wallet = _w` (public poll boundary: join campaign →
  poll, `is_public = true AND status IN ('live','closed')`). Public by default
  (privacy §16 allows it).
- **Recent reward history:** add a `reward` kind to the activity RPC:
  `{ kind: 'reward', pollId, question, amountLuna, at }` — poll title only,
  **no option**, matching the existing `created`/`participated` privacy rule.
- **Public vs private visibility:** totals + recent rewards are public (like
  NIM supported). Exact campaign-level funding details and payout tx IDs stay
  on the reward receipt page, not the profile — keep the profile lightweight.
- **Campaign reward amounts:** reward-per-participant is public (the offer);
  cumulative paid is creator-view only.
- **No chosen-option leakage:** the profile query and serializers never select
  `option_id` (existing allowlist architecture extended; see §17).

The profile RPC `get_participant_public_profile` changes its hardcoded
`'0'` to a real `SUM(...)` over paid receipts (see §15/§17 for exact SQL
boundary). Stats stay derived — never stored on the profile.

---

## 16. Data Model (Design Question 13)

**Recommended minimal schema — 5 tables** (all additive, RLS-enabled,
service_role-gated, public reads via security-definer functions):

### 16.1 `reward_campaigns` — one per poll

- **Purpose:** the campaign offer + lifecycle + balances.
- **Columns:** see §4 (`id`, `poll_id UNIQUE FK polls`, `creator_wallet`,
  `reward_per_participant_luna`, `max_rewarded_participants`,
  `total_budget_luna`, `asset` CHECK='NIM', `status`, `funded_amount_luna`,
  `rewarded_participant_count`, `paid_amount_luna`, `refundable_amount_luna`,
  `vault_wallet`, `vault_key_ref`, timestamps).
- **CHECKs:** `reward_per_participant_luna > 0`,
  `max_rewarded_participants > 0`,
  `total_budget_luna = reward_per_participant_luna * max_rewarded_participants`,
  `funded_amount_luna >= 0`, `paid_amount_luna >= 0`,
  `rewarded_participant_count >= 0 AND <= max`,
  `refundable_amount_luna >= 0`, `paid_amount_luna <= funded_amount_luna`.
- **Unique:** `poll_id` UNIQUE (one campaign per poll).
- **FK:** `poll_id → polls(id)`.
- **Security:** RLS enabled, `REVOKE ALL FROM anon, authenticated`, service_role
  `SELECT, INSERT, UPDATE` (no DELETE). Public reads via a security-definer
  function returning only the allowed surface (offer, funded state, remaining
  count, per-participant amount).

### 16.2 `reward_funding_transactions` — creator funding attempts

- **Purpose:** bind → observe → confirm lifecycle for the prepaid budget
  (mirrors `nim_support_intents`).
- **Columns:** `id`, `campaign_id FK`, `creator_wallet`, `reference` UNIQUE,
  `submitted_transaction_hash` (partial unique), `confirmed_transaction_hash`
  (partial unique), `amount_luna`, `status` (`submitted|confirmed|rejected`),
  `confirmation_deadline`, `block_number`, `transaction_timestamp`,
  `confirmed_at`, timestamps.
- **Unique/FK:** `reference` UNIQUE; partial-unique hashes (one hash used
  once); `campaign_id → reward_campaigns(id)`.
- **Security:** RLS + REVOKE anon/authenticated; service_role CRUD via the
  funding RPCs only.

### 16.3 `reward_receipts` — per-wallet entitlement ledger

- **Purpose:** prove "wallet X participated in poll Y and received Z NIM";
  reward-cap accounting; **never stores `option_id`**.
- **Columns:** `id`, `campaign_id FK`, `poll_id FK`, `participant_wallet`,
  `amount_luna`, `status` (`eligible|reserved|payout_pending|paid|failed|retryable`),
  `created_at` (= confirmed participation time; ordering source for first-N),
  `paid_at`.
- **Unique/FK:** `UNIQUE (campaign_id, participant_wallet)` (one reward max);
  FKs to `reward_campaigns(id)` and `polls(id)`.
- **Security:** RLS + REVOKE anon/authenticated; service_role only. The
  participant's own receipts are readable via an authenticated endpoint
  (`GET /api/me/rewards`) that returns only their own wallet's rows.

### 16.4 `reward_payout_attempts` — execution/retry log

- **Purpose:** idempotent retry of vault→participant broadcasts; audit trail.
- **Columns:** `id`, `receipt_id FK`, `attempt_number`, `status`
  (`pending|confirmed|failed|retryable`), `transaction_hash` (partial unique),
  `error_code`, `broadcast_at`, `confirmed_at`.
- **Unique/FK:** `UNIQUE (receipt_id, attempt_number)`; partial-unique
  `transaction_hash` against the whole payout ledger.
- **Security:** RLS + REVOKE anon/authenticated; service_role only.

### 16.5 `reward_refunds` — creator refund events

- **Purpose:** prove remainder returned to `creator_wallet`.
- **Columns:** `id`, `campaign_id FK`, `creator_wallet`, `amount_luna`,
  `status` (`pending|confirmed|failed|retryable`), `transaction_hash` (partial
  unique), `block_number`, `transaction_timestamp`, `confirmed_at`.
- **Unique/FK:** one active refund per campaign (partial unique on
  `campaign_id WHERE status IN ('pending','confirmed')` for simplicity, or a
  single `campaign_id` UNIQUE row updated in place); FK to
  `reward_campaigns(id)`.
- **Security:** RLS + REVOKE anon/authenticated; service_role + creator-gated
  initiation (the refund RPC checks the session wallet against
  `creator_wallet`).

**Deliberately not created (can be derived):** no `reward_balances` table
(derived from campaign columns), no per-option reward rows, no `users`
table, no activity-feed table.

**Status representation:** `text` + CHECK constraints — the repo convention
(no `CREATE TYPE` enums anywhere; `nim_support_intents.status` and `polls.status`
are text+CHECK).

---

## 17. Concurrency / Money Safety (Design Question 14)

**All financial transitions are single security-definer function bodies**
(one implicit transaction each), following the `publish_poll_atomic` /
`cast_poll_vote_atomic` / `confirm_nim_contribution_atomic` precedent. UI
counters are display-only.

| Hazard | Defense |
|--------|---------|
| Two users take the final reward slot | Campaign advisory lock (`pg_advisory_xact_lock` on a deterministic key from `campaign_id`) + capacity check + `rewarded_participant_count` increment inside one atomic claim; `UNIQUE(campaign_id, participant_wallet)` backstop. |
| Duplicate vote requests | Existing `UNIQUE(poll_id, voter_wallet)` + `cast_poll_vote_atomic` advisory lock; reward claim keyed to the same vote (replay returns the same receipt). |
| Duplicate payout requests | `UNIQUE(receipt_id, attempt_number)`; only `payout_pending` may become `paid`; guarded transition. |
| Payout success but DB timeout | Observe chain by hash first; the receipt can only be marked `paid` when a confirmed tx is recorded. If the DB write timed out, the observer re-checks the hash (idempotent). |
| DB success but broadcast failure | Payout attempt row `failed` before the balance changes; no receipt leaves `eligible/reserved` to `paid` without a confirmed hash. |
| Duplicate transaction observation | Partial-unique hash rows in funding/payout/refund ledgers; a hash used once anywhere is `transaction_already_used`. |
| Creator refund races with payout | Refund RPC requires no receipt in `reserved`/`payout_pending`/`retryable`; reconciliation settles first; refund amount computed from confirmed-paid only. |
| Campaign overspending | `paid_amount_luna` guarded `<= funded_amount_luna`; payout only while capacity remains; receipt amount fixed at claim. |
| Underfunded campaign advertised as funded | `funded` is set only by the confirmed funding RPC (recipient/amount/memo/networkId verified); the advertisement query checks campaign status server-side. |
| Stale client reward counters | All reward figures (remaining, paid, exhausted) are recomputed server-side per request from the ledger; no counter stored on the client. |

---

## 18. NIM Units (Design Question 15)

**Integer smallest units everywhere** — the repo's established convention:

- `1 NIM = 100,000 Luna` (`LUNA_PER_NIM = 100000n`, `src/lib/nimiq/units.ts`).
- DB columns: `amount_luna`, `min_nim_luna` (existing), new columns all
  `bigint ... luna`.
- Input: `nimDecimalToLuna(value: string)` — strict canonical parser (no
  signs/commas/exponents, max 5 decimals, **no rounding** — excess precision is
  an error).
- Display: `lunaToNim` / `formatNimAmount` ("X NIM") — float only at the UI
  boundary.
- **Reward-per-participant arithmetic:** `perLuna = nimDecimalToLuna("0.5") =
  50000n`. Stored integer. Payout value = `perLuna` exactly.
- **Budget arithmetic:** `total_budget_luna = perLuna × max` (bigint multiply;
  bounded by `PG_BIGINT_MAX`, and the mini-app SDK needs `Number ≤
  MAX_SAFE_INTEGER` — validated at funding time like the support amount).
- **Rounding policy:** none in storage — integer everywhere; the only rounding
  in the codebase is the deprecated display-only `nimToLuna`. Dust cannot exist
  below 1 Luna by construction; OQ-6 sets a sane minimum reward.

---

## 19. Privacy (Design Question 16)

Preserve V2B.1 privacy exactly.

**Publicly knowable:**

- wallet participated (already public via profile activity)
- wallet received reward (total + recent reward activity)
- reward amount (per-participant offer public; per-wallet earned public)

**Must remain private (structural):**

- selected option — never in receipts, payout memos, profile stats/activity,
  or any reward query.

**Confirmation that no reward query joins or exposes chosen-option data:**

- `reward_receipts` has **no `option_id` column** and no `poll_options` FK.
- `reward_payout_attempts` and `reward_refunds` reference receipt/campaign
  only.
- The public profile RPC's reward branch joins `reward_receipts → 
  reward_campaigns → polls` and selects only `polls.question` + amounts —
  never `poll_votes.option_id` and never `poll_options`.
- The serializer allowlist pattern (`src/lib/profiles/serialize.ts`) is
  extended: new keys are `{ kind:'reward', pollId, question, amountLuna, at }` —
  no option fields by construction.
- Payout memos are `votum-reward:<receiptId>` (or campaign id) — no option
  reference. Receipt page proves wallet+poll+amount only.

---

## 20. Failure Recovery (Design Question 17)

Recover from **chain truth** (RPC observation), not client callback truth —
the same philosophy as the NIM support confirm loop.

| Failure | State | Recovery |
|---------|-------|----------|
| Funding rejected in Nimiq Pay | no funding row / `submitted` cleared | clean `configured`/`funding_pending`; creator retries. |
| Funding broadcast but not confirmed | funding row `submitted`, deadline in future | re-observe `getTransactionByHash` on retry (client resumes via pending-local-storage like `votum_pending_nim_support_v1`). |
| Funding confirmed but app didn't observe immediately | funding row still `submitted` | retry observation; on confirmed hash → `confirmed`, campaign `funded`. Replay-safe via partial-unique hash. |
| Payout rejected/broadcast failure | payout attempt `failed` | receipt stays `reserved`/`eligible`; retryable attempt incremented; bounded retries. |
| Payout pending | `payout_pending` | re-observe by hash; confirm → `paid`. |
| Payout failed (permanent) | `failed` after retries | reserved amount returns to remainder at refund reconciliation; no double pay. |
| Payout confirmed but app missed callback | `payout_pending` | reconciliation job re-checks the stored hash; marks `paid`. |
| Refund pending/failed | refund `pending`/`failed`/`retryable` | re-observe the refund hash; on confirm → `confirmed`. |
| DB write after chain confirm (edge) | conflicting states | guarded transitions + unique hashes make the observer idempotent; a background reconciliation pass derives truth from confirmed hashes. |

The reconciliation job (a server cron/route invoked by the app, matching the
support confirm loop) is **derive-from-chain** — it never trusts a client.

---

## 21. MVP Boundary (Design Question 18)

**V2B.2 MVP does NOT include:** Cashlinks, reputation scoring, social graph,
advanced Sybil detection, multi-token rewards, USDC, creator teams, recurring
campaigns, NFT rewards, outcome predictions, leaderboards, streaks, referral
rewards, arbitrary reward formulas, custom reward tiers per option, per-poll
multiple campaigns. None are required by repository constraints.

---

## 22. Migration / Backward Compatibility (Design Question 19)

- **No reward campaign row → exactly today's poll behaviour.** All additions
  are new tables/functions/columns on `reward_*` only. No existing table is
  altered; no existing column/row changes.
- `polls`, `poll_votes`, `nim_*`, `participant_profiles`, sessions, receipts,
  My Polls, Explore, publish — all unchanged. A poll without a campaign is a
  normal free poll (reward surface hidden by query-time absence).
- Existing profiles/votes/support history remain valid; `nimEarnedLuna` only
  changes from `'0'` to a real sum for wallets with paid receipts (others stay
  `'0'`).
- One additive profile migration step extends the public profile RPC's stats +
  activity to include reward-derived numbers — still additive, still derived,
  still allowlisted.
- Rollout rule: migration lives on the feature branch only; **no `supabase db
  push`, no link, no hosted Supabase changes, no deploy, no merge to main** in
  this or the implementation step.

---

## 23. MVP Exclusions (Design Question 18 restated as a boundary)

- Cashlinks / HTLC / multisig / smart contracts (no repo/SDK support).
- Public-choice polls; rewards never reveal choice.
- Claim-with-expiry, unclaimed balances.
- Multiple campaigns per poll, custom tiers, formula-based rewards.
- Any change to the voting rule or fairness model.
- Identity/reputation infrastructure beyond the honest boundary in §11.

---

## 24. Security Risks

| Risk | Mitigation |
|------|-----------|
| Vault key theft (custody) | Per-campaign key, encrypted at rest, no export, one-campaign blast radius, documented key lifecycle; migration path to HSK/HSM. |
| Reward-cap race manipulation | DB advisory lock + unique receipts; no client trust. |
| Double payout | Unique hashes + guarded `→ paid` transitions + payout attempt log. |
| Underfunded advertised as rewarded | `funded` set only by confirmed chain observation; advertisement gated on DB status. |
| Forged funding (client lies about payment) | Chain verification of recipient/amount/memo/networkId; sender deliberately not required (consistent with support). |
| Creator self-reward / farmed wallets | Creator excluded from own pool; farmed wallets earn like any wallet (honest boundary, §11); no overbuild. |
| Option-leak through rewards | No option_id in any reward table, memo, profile, or API shape; allowlist serializers. |
| Refund misdirection | Refund destination = immutable `creator_wallet`; session must match; no wallet-redirect. |
| Nonce/fee manipulation on broadcasts | Server-side signing with explicit fee policy; observe+confirm before state change; retry bounded. |
| Excessive transaction volume / fee drain | Cap on participants, bounded retries, explicit fee policy (creator pays; OQ-3/OQ-6). |
| UI counter divergence | All reward figures server-derived; no client counters as truth. |

---

## 25. Open Questions (genuine product decisions)

- **OQ-1 — Creator self-participation:** exclude the campaign creator from
  their own reward pool (recommended) or allow? 
- **OQ-2 — Private polls:** reward campaigns only on public polls (recommended)
  or allow private rewarded polls?
- **OQ-3 — Payout delivery:** automatic payout (recommended) vs explicit
  claim vs batched? This sets the transaction-volume and fee posture.
- **OQ-4 — Refund timing:** explicit creator-triggered refund (recommended) vs
  automatic refund after a grace window?
- **OQ-5 — Overpayment:** hold excess until close and fold into remainder
  (recommended) vs auto-refund immediately on over-funding?
- **OQ-6 — Minimum reward:** set a minimum reward-per-participant (e.g., ≥ 1
  Luna, or a friendlier floor) to avoid dust and absurd micro-payouts?
- **OQ-7 — Public budget visibility:** show the exact funded budget publicly or
  only "Rewards funded" status?
- **OQ-8 — Explore depth:** filter + badge only (recommended) vs an "Earn NIM"
  section or sort?
- **OQ-9 — Fee policy:** creator pays all vault payout fees (recommended) vs
  deduct from the budget vs participant-shared?
- **OQ-10 — Campaign cancellation after funding but before publish:** full
  refund only, or also allow a publish-without-advertising fallback?

---

## 26. Recommended V2B.2 Implementation Slices (sequencing only — no plan)

> These are suggested work slices for a later implementation-plan step, not an
> implementation plan. Nothing is built now.

1. **Slice 0 — Spike:** verify server-side `@nimiq/core` keypair → sign a
   basic NIM transaction → broadcast via Nimiq RPC `sendTransaction` →
   observe by hash. Gate for the whole custody approach.
2. **Slice 1 — Schema + contracts:** the 5 reward tables, CHECKs, unique
   constraints, security-definer functions, grants; `v2b2-*` contract tests.
3. **Slice 2 — Funding flow:** configure reward in create; funding intent/bind/
   observe/confirm; publish gate (`reward_funding_required`); overpayment.
4. **Slice 3 — Eligibility + claims:** reward receipt fused into the vote
   transaction; cap race; creator exclusion; exhausted/late-vote semantics.
5. **Slice 4 — Automatic payouts:** vault signing, broadcast, observe,
   receipt lifecycle, retry/reconciliation job.
6. **Slice 5 — Refunds:** close reconciliation, remainder, refund RPC,
   idempotency, proofs.
7. **Slice 6 — Public UX:** reward badge + remaining count + exhausted state +
   reward receipt page on the poll.
8. **Slice 7 — Explore:** rewarded filter + PollCard badge + `PollCardData`
   extension.
9. **Slice 8 — Creator UX:** reward management surface in My Polls + immutable
   config.
10. **Slice 9 — Profile:** reward stats + reward activity kind + allowlist
    extension.
11. **Slice 10 — Full gate:** V2B.2 suites + all V2A/V2B.1 suites + typecheck +
    lint + build + device QA, then independent #21 HTTPS retest as a
    prerequisite (§27).

---

## 27. #21 HTTPS Follow-up (Design Question 20)

V2B.1's single remaining production-verification item is carried **unchanged**
into the rollout checklist as an **independent prerequisite before production
verification**:

> **T12 #21 — same-wallet reconnect/session restore over HTTPS.** Local HTTP
> host limitation (Nimiq Pay iOS WebView does not persist the `votum_session`
> cookie after Mini App close/reopen over local HTTP). Not a Votum code bug; no
> auth weakening applied. HTTPS retest required on a secure production origin.

V2B.2 does **not** fix or redesign it. Reward settlement depends on session
integrity, so this retest gates production rollout but not V2B.2 development.

---

## 28. Self-Review

- **Outcome-linked rewards?** No — fixed per-participant reward, no option/
  winner/majority linkage anywhere in schema, RPC, memos, or UI. Brand
  vocabulary (signal/support/contribution, never bet/odds/pot/payout-on-winner)
  preserved.
- **Fake balances?** Every figure derived from the ledger at read time; `funded`
  only from confirmed chain observation; zero is truthful zero.
- **One-wallet-one-vote preserved?** Yes — untouched; rewards attach to the
  existing vote uniqueness.
- **Privacy preserved?** Reward receipts carry no `option_id`; profile activity
  adds `reward` kind with poll title only; allowlist serializers extended.
- **Money safety?** Integer Luna only; atomic security-definer transitions;
  unique hashes; guarded state machines; chain-truth reconciliation.
- **Backward compatible?** Additive tables/functions only; no-campaign poll =
  today's behaviour; existing history valid.
- **MVP bounded?** No cashlinks/reputation/social/multi-token/leaderboards/
  formulas (§23).
- **#21 carried forward?** Yes (§27), as an independent HTTPS prerequisite.

---

## Completion Criteria (for the future implementation step)

V2B.2 is complete when:

- Campaign lifecycle states are exactly as specified and truthfully surfaced
- Rewarded polls are advertised only when funded; no fake reward CTA
- Reward is per-participant, outcome-independent, one-reward-per-wallet-per-campaign
- Funding/payout/refund all derive from confirmed chain observation
- Automatic payouts settle with idempotent retry; no double pay, no cap race
- Public poll + Explore + creator + profile surfaces per spec
- All V2B.2 + V2A + V2B.1 suites pass; typecheck/lint/build pass; device QA done
- #21 HTTPS retest carried into the rollout checklist as an independent
  prerequisite
- No hosted Supabase changes, no deploy, no merge to main
