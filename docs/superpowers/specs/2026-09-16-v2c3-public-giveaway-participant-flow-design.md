# V2C.3 Public Giveaway Participant Flow Design

**Status:** Design specification only. This document does not implement
production code, migrations, routes, UI, claim flows, eligibility storage,
challenge storage, NIM transfers, deployment, or creator management. It does
not start V2C.3A. It does not modify hosted Supabase or send NIM.

**Branch:** `feat/v2-participation-record`

**Reviewed commit:** `f432b23 test(v2c2): verify Campaign foundation and root cutover`

**Design date:** 2026-09-16

**Scope:** Public Giveaway only. First complete Campaign participant vertical
slice over the existing shared settlement engine.

**Primary evidence:**

- `docs/superpowers/specs/2026-09-12-v2c1-shared-nim-participation-engine-design.md`
- `docs/superpowers/specs/2026-09-13-v2c2-campaign-foundation-design.md`
- `docs/superpowers/plans/2026-09-13-v2c2-campaign-foundation-implementation.md`
- `docs/superpowers/reviews/2026-09-12-v2c0-campaign-integration-readiness-audit.md`
- `supabase/migrations/20260913080000_v2c2_reward_settlements.sql`
- `supabase/migrations/20260913083000_v2c2_participation_campaigns.sql`
- `supabase/migrations/20260913084000_v2c2_campaign_settlement_binding.sql`
- `supabase/migrations/20260913085000_v2c2_financial_root_cutover.sql`
- `supabase/migrations/20260913086000_v2c2_poll_read_root_cutover.sql`
- `src/lib/rewards/participation.ts`
- `src/lib/rewards/poll-participation-adapter.ts`
- `src/lib/rewards/reservation-service.ts`
- `src/lib/rewards/settlement.ts`
- `src/lib/rewards/closure.ts`
- `src/lib/rewards/poll-closure-adapter.ts`
- `src/app/api/wallet-proof/challenge/route.ts`
- `src/app/api/wallet-proof/verify/route.ts`
- `DESIGN.md`
- `docs/brand-messaging.md`
- `docs/votum-product-idea.md`

---

## 1. Product Thesis

Votum is a NIM-powered verified participation network.

V2C.3 is the first complete Campaign participant vertical slice, restricted to
**Public Giveaway only**. It proves that a standalone
`participation_campaigns` row of type `public_giveaway` can move from creator
configuration to participant-paid finality using the existing shared settlement
engine, without creating a second financial ledger or a Campaign-specific
payout engine.

Target lifecycle:

```text
creator configures
  -> funds (exact NIM to settlement vault, server-confirmed)
  -> publishes / shares link
  -> participant opens link
  -> verifies wallet
  -> signs Claim NIM (claim-specific signature)
  -> atomic entitlement reservation (reward_receipt)
  -> automatic server payout
  -> finality / proof
  -> creator closes (early or scheduled end stops NEW claims only)
  -> existing obligations settle
  -> unused NIM refunded to server-derived recipient
```

Votum remains a verified-participation product. This slice never uses betting,
prediction-market, gambling, odds, pot, winner-payout, or investment language
or mechanics. Every participant receives the same advertised fixed reward.
Reward eligibility never depends on choosing a particular option, because a
Public Giveaway has no options at all.

---

## 2. Locked UX / Product Decisions Traceability

All eighteen locked decisions are normative. Each carries an ID used by later
sections and by the V2C.3A–F gates.

| ID | Locked decision | Enforced by |
|---|---|---|
| L1 | Participant uses an explicit **Claim NIM** action. There is no automatic Campaign reservation on page view, wallet connect, or session creation. | Sections 6, 11 (V2C.3D gates V2C.3E) |
| L2 | Claim is reservation-first. Once the atomic reservation succeeds, the entitlement belongs to that wallet even if payout is pending, delayed, or retried by the server. | Sections 6, 7 |
| L3 | Creator cannot claim their own Campaign. The creator wallet is reward-ineligible but the Campaign remains manageable by the creator. | Sections 4, 6, 13 |
| L4 | Published but unfunded Campaign remains viewable and shareable, but Claim NIM is disabled and no entitlement can be created. Publication and funding are both visible; neither alone enables claiming. | Sections 4, 8, 9 |
| L5 | Claim creation requires a claim-specific wallet signature over a server-created challenge. A base wallet session alone never authorizes a claim. | Section 5 |
| L6 | One Campaign plus one canonical wallet equals one durable entitlement. Duplicate attempts return the existing entitlement; they never create a second receipt. | Sections 6, 7 |
| L7 | Existing reservation survives scheduled expiry or early close. Close stops new claims; it never deletes, voids, or refunds an existing reservation while its payout obligation is unresolved. | Sections 4, 6, 10 |
| L8 | Payout recovery is server-managed. There is no participant retry-send button. Participant UI shows status and proof only. | Section 7 |
| L9 | Once a claim exists, a normal verified session may read its status without another claim signature. The claim signature authorizes creation; the session authorizes own-status reads. | Sections 5, 9 |
| L10 | V2C.3 is share-link first. Explore and discovery are deferred. The Campaign is reached by a direct link, not by browsing. | Section 9 |
| L11 | Public page shows exact reward per participant and exact remaining reward count from authoritative settlement state. No estimates, no client-computed capacity. | Section 9 |
| L12 | No public claimant wallet list. Public sees aggregate stats only. A connected wallet sees only its own claim state. | Section 9 |
| L13 | V2C.3 includes a minimal Campaign funding flow. A Campaign with no funding path cannot reach the vertical-slice gate. | Section 8, Section 11 (V2C.3A) |
| L14 | Fund Campaign initiates an exact NIM transfer from the creator's connected wallet to the authoritative settlement vault, and Votum tracks confirmation and finality server-side. | Section 8 |
| L15 | V2C.3 includes Close and Refund. A slice without terminal closure and unused-remainder refund is incomplete. | Section 10, Section 11 (V2C.3F) |
| L16 | Creator may close early. Early close stops NEW claims only. Existing reservations remain obligations that must settle before any refund. | Sections 4, 10 |
| L17 | Funding and publishing are independent prerequisites. Claiming requires both to be satisfied. Neither implies the other, and the UI states each separately. | Sections 4, 8, 9 |
| L18 | Scheduled starts are supported. A published and funded Campaign may show "Starts at …". Claiming activates automatically at `starts_at` through the time check in the eligibility predicate; no operator action or background job flips a stored claimable flag. | Section 4 |

---

## 3. Approved Architecture

### 3.1 Thin adapter over the existing shared engine

Use a thin Public Giveaway adapter over the existing shared settlement engine.
Do not build a Campaign-specific payout engine, a second financial ledger, or
a generic eligibility framework for all Campaign types.

Ownership boundary:

| Layer | Owns | Does not own |
|---|---|---|
| Public Giveaway adapter | Eligibility evaluation, claim authorization (challenge issue/verify), claim intent construction, source-to-settlement binding resolution, public/own-wallet read models, Campaign-side translation of generic financial results | Capacity, financial state, funding confirmation, receipt creation authority, payout signing, reconciliation, finality, closure/refund math |
| `reward_settlements` engine (existing) | Capacity, financial state, funding lifecycle, receipt entitlement creation, payout preparation/signing/broadcast, reconciliation and finality, closure freeze, refund preparation/confirmation | Campaign product metadata, claim challenge contents, share-link presentation, product-specific error wording |
| Shared funding RPCs (`begin_reward_funding_atomic`, `bind_reward_funding_transaction_atomic`, `confirm_reward_funding_atomic`) | One settlement-canonical contract for Poll and Campaign: generic source resolution, settlement economics, hash guards, finality | Product-specific error wording, Poll-shaped argument names, Poll/Campaign RPC forks, a second funding ledger |
| Poll compatibility boundary (adapter, service parsers, routes) | Poll-side translation of generic financial results back into the existing Poll route/API vocabulary; Poll publicity pre-checks | Financial authority, settlement economics, vault custody |
| `participation_campaigns` row | Product metadata, type literal, title/description, visibility, window, product status, configuration freeze markers | Balances, counters, vault material, receipts, hashes, refund math |
| `settlement_source_bindings` row | Narrow source-to-root relationship for the Campaign branch | Terms, balances, secrets, allowlists, proofs |

Conceptual participant flow:

```text
public Campaign page (/campaigns/[campaignId] conceptual)
  -> verified wallet session (base wallet control)
  -> claim challenge issue (server-created, Campaign-bound)
  -> claim-specific signature (participant wallet)
  -> Public Giveaway eligibility adapter
  -> atomic reservation (settlement-locked, Section 6)
  -> reward_receipt (durable entitlement)
  -> existing payout engine (RewardSettlementService)
  -> reconciliation / finality (existing observation boundary)
  -> paid proof
```

### 3.2 V2C.2 financial architecture preserved

V2C.3 preserves every V2C.2 invariant:

- `reward_settlements` is the sole mutable financial authority after the
  V2C.2E cutover. All funding, reservation, payout, reconciliation, closure,
  and refund writes resolve through the settlement row under lock.
- Settlement ID is the canonical RPC identity for funding. The three shared
  funding RPCs (`begin_reward_funding_atomic`,
  `bind_reward_funding_transaction_atomic`, `confirm_reward_funding_atomic`)
  serve Poll and Campaign through one contract whose first UUID argument is
  `_settlement_id`. There is no product-specific funding RPC fork and no
  surviving Poll-shaped overload after the D1 cutover.
- `settlement_id` is the vault authority. Vault lookup, signing context, and
  AAD resolution use `reward_campaign_vaults.settlement_id`. The AAD byte
  format `UTF-8("votum:reward-vault:v1" + NUL + <settlement UUID text> + NUL +
  <lowercase vault_address_hex>)` is unchanged. No re-encryption, no new
  envelope version, no vault material on `reward_settlements` or
  `participation_campaigns`.
- Poll compatibility is preserved. `reward_campaigns` remains the Poll
  adapter, `poll_id NOT NULL UNIQUE` is untouched, Poll vote-before-reward
  semantics are unchanged, and Poll automatic payout remains Claim-free.
- The Campaign product and configuration foundation exists
  (`participation_campaigns`, Campaign branch of
  `settlement_source_bindings`, settlement-rooted vault rows with
  `campaign_id IS NULL` for standalone Campaigns). V2C.3 adds the participant
  claim flow that V2C.2 deliberately deferred; it does not redesign the
  foundation.
- No Campaign participant claim flow exists yet. V2C.3 is the first slice
  that creates one, and only for `campaign_type = 'public_giveaway'`.

### 3.3 Rejected alternatives (reaffirmed for V2C.3)

- **Campaign-specific payout engine:** rejected. It would duplicate signing,
  broadcast markers, hash-reuse guards, retry bounds, finality policy, and
  vault-lease serialization.
- **Campaign-specific funding RPCs** (`begin_campaign_funding_atomic`,
  `bind_campaign_funding_transaction_atomic`,
  `confirm_campaign_funding_atomic`): rejected. Polls and Campaigns share
  one funding engine; forking it would split hash-reuse guards, finality
  policy, and confirmation accounting across two money paths.
- **Legacy Poll-shaped funding RPC overloads:** rejected. After the D1
  cutover there is exactly one callable funding contract per operation;
  no `_campaign_id` overload, compatibility wrapper, or second Poll-shaped
  entry point survives.
- **Second financial ledger or Campaign financial-claim table:** rejected as
  the default. `reward_receipts` is the durable entitlement (Section 7). A new
  table is permitted only if a repo constraint makes reuse literally
  impossible, and the implementing slice must then prove in its plan why reuse
  failed and how the new table remains a projection rather than a second
  money authority. The default design has no such table.
- **Generic eligibility framework for all Campaign types:** rejected for
  V2C.3. Secret Drop, Private Drop, Event Drop, and Community Reward keep
  their V2C.2 status: selectable and storable type literals with no
  implemented strategy. Only `public_giveaway` gains an adapter.
- **Stored trusted `claimable` column:** rejected. Claimability is a derived
  read-model predicate re-evaluated authoritatively at reservation time
  (Section 4). Storing it would create a second source of truth that can
  drift from settlement state, window, publication, and closure.

---

## 4. Eligibility

### 4.1 Authoritative predicate

Public Giveaway claim eligibility requires ALL of the following, evaluated
from server-loaded authoritative rows at reservation time:

1. `participation_campaigns.campaign_type = 'public_giveaway'`.
2. `participation_campaigns.status = 'published'`. Draft, closed, expired,
   and cancelled are ineligible for new claims.
3. Current time is at or after `starts_at` when `starts_at` is set
   (`now >= starts_at`). A set future `starts_at` yields a "Starts at …"
   presentation with Claim NIM disabled; no stored flag flips at start time.
4. Current time is before `ends_at` when `ends_at` is set (`now < ends_at`).
   At or after `ends_at` the Campaign is ineligible for new claims; existing
   reservations survive per L7.
5. Campaign is not manually closed. `status = 'closed'` (early creator close)
   or `status = 'cancelled'` rejects new claims immediately, before any
   capacity check.
6. Settlement is reward-ready: the bound `reward_settlements` row exists, its
   binding resolves through `settlement_source_bindings` with
   `source_type = 'participation_campaign'`, and its `status` is `funded` or
   `rewarding`. `configured`, `funding_pending`, `closed`, `refunding`,
   `refunded`, `cancelled`, and `exhausted` reject new claims at the financial
   layer. `exhausted` is the capacity-terminal form of rejection.
7. Remaining capacity is greater than zero under the settlement lock:
   `rewarded_participant_count < max_rewarded_participants`.
8. Participant canonical wallet differs from the Campaign owner wallet under
   canonical comparison (lowercase 40-character hex). Creator self-claim is
   rejected by both the adapter pre-check and the atomic reservation
   defense-in-depth.
9. No existing `reward_receipts` row exists for the tuple (settlement,
   canonical participant wallet). Existence short-circuits to the idempotent
   replay path (Section 6), which is a success-with-existing-receipt rather
   than an eligibility error.

Conditions 1–8 gate creation of a NEW entitlement. Condition 9 diverts to the
durable replay path before capacity is consumed, so a duplicate never burns
the last slot.

### 4.2 Evaluation rules

- All conditions are re-evaluated authoritatively inside the atomic claim
  transaction from freshly locked rows. Adapter pre-checks are UX hints and
  fail-closed guards only; they never substitute for the in-transaction
  re-check.
- There is no stored trusted `claimable` field on any table. Read models may
  expose a derived `claimState` projection (for example `needs_funding`,
  `starts_soon`, `open`, `full`, `ended`, `closed`), but the projection is
  never read back as an authority by any write path.
- Canonical wallet comparison uses the V2C.2 invariant: lowercase 40-character
  hexadecimal Nimiq address produced by the production `normalizeAddress`
  path. Adapter and reservation layers both canonicalize before comparing.
- Time comparisons use server time (`now()` at the database layer for the
  authoritative check). Client clocks never decide window eligibility.
- Funding readiness and publication are independent. The read model reports
  them as two separate facts (`published: true/false`,
  `fundingReady: true/false`). Claim requires both. A published-but-unfunded
  Campaign (L4) shows its reward terms and share surface with Claim NIM
  disabled; an unpublished-but-funded Campaign shows no public claim surface
  at all.
- Scheduled start (L18) is a pure time predicate. When `starts_at` is in the
  future, the public page shows "Starts at …" with Claim NIM disabled. When
  server time reaches `starts_at`, subsequent challenge and reservation
  attempts pass the time check without any state migration or operator step.

### 4.3 Distinguishing published, funded, and claimable

These three words have disjoint meanings throughout V2C.3 and must never be
conflated in specs, plans, code, or copy:

- **Published** is product state: `participation_campaigns.status =
  'published'` with a frozen published configuration version. It means the
  creator has made the Campaign shareable. It does not mean money is present.
- **Funded** is financial state: the bound settlement has passed
  server-observed funding confirmation and holds `status = 'funded'` (or has
  since moved to `rewarding` through reservations). It means NIM is present
  in the isolated vault. It does not mean the Campaign is published.
- **Claimable** is a derived, momentary read-model statement meaning the full
  Section 4.1 predicate currently evaluates true for a given viewer. It is
  never persisted, never trusted by a write path, and can change between two
  reads as capacity, window, publication, closure, or funding change.

---

## 5. Claim Authorization

### 5.1 Challenge model (conceptual)

Add a small server-private challenge record, conceptually named
`campaign_claim_challenges`, with at least:

- `id` (primary key, random UUID).
- `campaign_id` (references `participation_campaigns(id)`).
- `participant_wallet` (canonical lowercase 40-hex, the wallet that requested
  the challenge).
- `nonce_hash` (SHA-256 hash of a server-generated random nonce; the raw
  nonce is returned once to the requester for message construction and is
  never stored).
- `action` and `version` (for example `action = 'campaign_claim'`,
  `version = 1`; the signed message pins both).
- `issued_at`, `expires_at` (approximate 5-minute TTL, matching the existing
  wallet-proof challenge discipline).
- `consumed_at` (nullable; set atomically on successful reservation).
- `created_at`.

Challenge rows are never public. No read model exposes nonces, nonce hashes,
expiry internals, or consumption state. RLS revokes `anon` and `authenticated`
access; only the service role touches this table through security-definer
functions.

### 5.2 Deterministic server-created message

The claim message is constructed server-side at challenge-issue time and
returned with the challenge. The participant wallet signs exactly those bytes.
The message binds at minimum:

- exact Campaign ID;
- canonical participant wallet;
- action and version (`campaign_claim` / `1`);
- random nonce (single-use);
- issued time and expiry time;
- network and domain origin following the existing wallet-proof signature
  pattern (same-origin discipline, domain binding where the signature scheme
  supports it).

The server verifies the signature against the canonical wallet, the stored
nonce hash, the Campaign binding, the action/version, and the expiry window.
A signature issued for Campaign A never authorizes Campaign B; a signature
issued for wallet W never authorizes wallet X; an expired or already-consumed
challenge never authorizes any claim. Verification failure is fail-closed with
a generic error that does not disclose which field mismatched.

### 5.3 Ordering and lifetime rules

- Approximate expiry is 5 minutes from issue. Expired challenges are rejected
  and may be garbage-collected by a later maintenance slice; expiry never
  extends an entitlement.
- Challenge issue requires a verified wallet session and a Campaign that is
  at least published. Issue-time eligibility screening (window, closure,
  creator exclusion, funding readiness, capacity snapshot) is a courtesy
  fail-fast only; the authoritative decision happens in Section 6.
- The wallet that requests the challenge must equal the wallet that signs and
  the wallet that claims. Any mismatch fails closed.
- Challenge consumption happens atomically with reservation inside the single
  authoritative claim transaction (Section 6). Challenge consumption and
  reservation are never independent commits: a committed reservation always
  implies a consumed challenge, and a consumed challenge never exists without
  its corresponding reservation-or-replay outcome in the same commit.
- Normal verified-session reads of an already-created claim (L9) do not
  require a claim challenge or claim signature. The session proves wallet
  control for reads; the challenge proves claim intent for creation.

---

## 6. Atomic Claim

### 6.1 One authoritative claim transaction

Design one authoritative claim transaction (a security-definer function or an
equivalent single-database-transaction service boundary with identical atomic
semantics) that executes in this order:

1. Accepts only trusted-server inputs: Campaign ID, canonical participant
   wallet, validated challenge reference, and server-verified signature
   evidence. The signature itself is verified before entering the mutation,
   but the challenge row is locked and rechecked inside the transaction.
2. Resolves Campaign to settlement through `participation_campaigns` →
   `settlement_source_bindings` (Campaign branch) → `reward_settlements`.
   Any binding mismatch, missing settlement, or wrong source type aborts.
3. Locks authoritative state in a deterministic order: settlement row first,
   then challenge row, then the existing-receipt lookup key. The settlement
   lock serializes capacity decisions; the challenge lock serializes
   consumption.
4. Rechecks challenge validity under lock: exists, belongs to this Campaign
   and wallet, action/version matches, not expired against database time, not
   already consumed.
5. Checks for an existing entitlement for the tuple (settlement, canonical
   participant wallet). If present, consumes the challenge only if it is still
   unconsumed, and returns the existing receipt idempotently without touching
   capacity, counters, or financial status. This is the duplicate path (L6).
6. Otherwise re-checks the full Section 4.1 eligibility predicate from the
   freshly locked rows: type, publication, window, manual closure, settlement
   reward-readiness, remaining capacity, and creator exclusion. Any failure
   aborts without consuming capacity. Challenge consumption on terminal
   ineligibility is an implementation detail of the slice plan, but a failed
   claim never creates a receipt and never decrements capacity.
7. Creates the `reward_receipts` reservation with the exact server-loaded
   settlement amount and canonical participant identity, increments
   `rewarded_participant_count`, transitions settlement `funded → rewarding`
   or into `exhausted` when the cap is reached, and sets
   `first_reservation_at` when first set. All in the same commit.
8. Consumes the challenge (`consumed_at = now()`) in the same commit.
9. Commits once. Returns the receipt identity and the derived participant
   status. The caller then enqueues the existing automatic payout path
   outside the reservation commit, exactly as the Poll path does.

Steps 5–8 plus the commit are indivisible. There is no observable state in
which the challenge is consumed but the receipt is missing, or the receipt
exists but the challenge appears reusable.

### 6.2 Concurrency semantics

- **Duplicate same-wallet races:** two concurrent claims from the same wallet
  for the same Campaign serialize on the settlement lock and the receipt
  uniqueness key. Exactly one creates the receipt; the other (and any later
  retry) takes the Section 6.1 step-5 replay path and receives the same
  receipt identity. The unique constraint on (settlement, canonical wallet)
  is defense-in-depth behind the pre-insert lookup.
- **Two wallets racing the last slot:** both serialize on the settlement
  lock. The first rechecks capacity, reserves, and commits. The second
  rechecks capacity after the first commit, observes zero remaining, and
  receives a typed no-capacity result. Capacity never goes negative; the
  `rewarded_participant_count <= max_rewarded_participants` check constraint
  remains the final guard.
- **Retry after HTTP uncertainty:** the client retries with a fresh challenge
  or replays the original request key according to the slice plan's transport
  rule; either way the server resolves to the existing receipt by the
  (settlement, wallet) tuple and returns it. Retries never create a second
  receipt and never trigger a second payout attempt for the same receipt
  beyond the existing payout engine's own idempotent attempt discipline.
- **Close or expiry racing a claim:** the in-transaction re-check decides.
  A claim that commits before the close commit holds a durable reservation
  that survives (L7). A claim that rechecks after the close commit is
  rejected. There is no torn outcome in which a claim both survives and is
  rejected.

### 6.3 Idempotency statement

Claim idempotency key is the durable tuple (Campaign settlement, canonical
participant wallet). Challenge nonces provide replay safety for the signature;
the receipt tuple provides idempotency for the entitlement. The spec fixes
both: nonce reuse across claims fails closed, while receipt-tuple retry
succeeds with the existing receipt. No ambiguous "maybe created" state is
exposed to the participant; the response is either the receipt (new or
replayed) or a typed rejection.

---

## 7. Entitlement / Payout

### 7.1 `reward_receipts` is the durable entitlement

Do not create a second Campaign financial-claim table. The preferred and
normative design uses the existing `reward_receipts` row as the durable
entitlement, reached through `reward_receipts.settlement_id` after the V2C.2E
cutover. Poll compatibility columns remain frozen where the cutover retained
them, but Campaign claims never write a `reward_campaigns` row and never set
a Poll `poll_id` on the receipt.

Justification for reuse: the receipt already carries the exact amount,
canonical participant, settlement linkage, status lifecycle, payout-attempt
lineage, and finality linkage that an entitlement needs. A parallel table
would split hash-reuse guards, signing lineage, retry bounds, and refund
accounting across two ledgers and is therefore rejected unless a future
implementation plan proves reuse literally impossible against the shipped
schema.

### 7.2 Participant-facing lifecycle derives from receipt truth

Participant status is a read-model derivation from existing receipt and payout
truth, not a new stored state machine:

- **Claim reserved:** receipt exists with status `reserved`. The entitlement
  belongs to the wallet (L2). Copy states the NIM is secured for this wallet
  and sending follows automatically.
- **Sending NIM:** a payout attempt exists in its pre-broadcast or
  broadcast-started phase for this receipt.
- **Confirming on-chain:** a broadcast hash exists and is under observation
  short of macro finality.
- **Paid:** receipt status `paid` after exact observed transfer and
  canonical-plus-macro finality, confirmed through the existing atomic payout
  confirmation.
- **Payout delayed:** the receipt remains valid while its payout attempt is
  in retryable, unknown, or manual-review handling inside the existing
  engine. The entitlement stays intact; the UI states the NIM remains secured
  and no participant action is needed.

There is no generic "failed, retry send" participant state and no participant
retry-send control (L8). Hash-bearing uncertainty is never blindly resent;
bounded hashless pre-broadcast retry, reconciliation-by-stored-hash, and
manual-review escalation all follow the existing payout policy unchanged.

### 7.3 Server-managed payout and recovery

After the reservation commit, the server enqueues and executes payout through
the unchanged `RewardSettlementService` path: durable attempt preparation,
vault-lease acquisition, server-side signing with transient key material,
signed-bytes and hash persistence before network contact, broadcast-start
marker before send, observation of the stored hash, exact sender/recipient/
amount/network/execution checks, canonical inclusion plus finalizing
macro-block evidence, and atomic `paid` confirmation. Payout recovery
(reconciliation workers, bounded retry, manual review) is entirely
server-managed. The participant surface polls or subscribes to derived status
and proof; it never signs, broadcasts, or retries a transfer.

---

## 8. Funding

### 8.1 Minimal Campaign funding flow

V2C.3 includes the minimal Campaign funding flow (L13) by adapting the
existing settlement funding engine to the Campaign branch. No new funding
ledger, no new vault table, no new finality policy.

Conceptual flow:

```text
creator connects wallet (verified session, owner wallet)
  -> server derives settlement, authoritative funder, vault address,
     exact required amount (total_budget_luna), funding reference, network
  -> connected Nimiq wallet sends the exact transaction to the vault
  -> client returns the transaction hash (callback only, never proof)
  -> server independently observes the hash and verifies sender, recipient,
     amount, network, hash uniqueness, execution, and finality
  -> atomic funding confirmation moves settlement toward funded
```

### 8.2 Server authority rules

- The browser never determines authoritative economics. Amount, vault
  recipient, reference/memo, network, and deadline are server-derived from
  the locked settlement and vault rows.
- The designated funder for the V2C.3 slice is the Campaign owner wallet
  (`funding_mode = 'creator'` implies `funding_wallet = owner_wallet` per the
  V2C.2 check constraint). Community funding mode remains a stored literal
  but gains no V2C.3 participant or multi-funder flow.
- Server verification covers sender equality, vault-recipient equality,
  exact amount equality, network equality, transaction-hash uniqueness across
  funding/payout/refund ledgers, successful execution, canonical inclusion,
  and macro finality before confirmation. Underpayment cannot activate the
  settlement. A single confirmed overpayment is accounted as
  `refundable_excess_luna` per existing policy; unsolicited extra transfers
  require explicit reconciliation before the Campaign is treated as safely
  closed.
- The funding UI states the exact NIM total once, shows vault-destination
  confirmation context without exposing private key material, and tracks
  confirmation/finality progress from server reads. It never advances the
  Campaign to funded on the basis of a wallet callback alone.

### 8.3 Shared settlement funding contract (D1 cutover)

One funding engine serves Polls and participation Campaigns. The three
shared RPCs keep their names:

- `begin_reward_funding_atomic`
- `bind_reward_funding_transaction_atomic`
- `confirm_reward_funding_atomic`

Their canonical first UUID argument is `_settlement_id`, not the Poll-shaped
`_campaign_id`. Because Supabase RPC invocation uses named arguments, D1
performs a single atomic contract cutover: the old internal definitions are
dropped and recreated with the same names and argument TYPE signatures under
the new argument name, with `SECURITY DEFINER`, `search_path`, volatility,
grants, and ownership preserved. Every server-side Poll and Campaign caller
moves in the same reviewed slice. No legacy overload, compatibility wrapper,
or second callable Poll-shaped contract survives.

Inside the RPCs, `_settlement_id` resolves through `reward_settlements` to
`settlement_source_bindings` and exactly one owning product source:

- Branch A (Poll): `source_type = 'poll_reward_campaign'` with the
  historical `reward_campaigns` compatibility row present.
- Branch B (Campaign): `source_type = 'participation_campaign'` with
  `participation_campaigns` present and no `reward_campaigns` row created
  or fabricated.

Source identity serves ownership and product compatibility checks only. All
funding economics and lifecycle state come from `reward_settlements`.

Funding-row authority follows the settlement:

- Poll row: `settlement_id` is the Poll settlement UUID and `campaign_id`
  carries the historical `reward_campaigns` UUID.
- Campaign row: `settlement_id` is the Campaign settlement UUID and
  `campaign_id` is `NULL`.

`settlement_id` is authoritative for both. `campaign_id` is nullable Poll
compatibility metadata only. No `participation_campaign_id` column is added
to `reward_funding_transactions`; product ownership resolves through the
funding row to the settlement to the source binding, never through a
duplicated product FK in the financial ledger.

The generic funding layer emits source-neutral financial errors only. The
canonical vocabulary is `created`, `replay`, `bound`, `bound_replay`,
`confirmed`, `settlement_not_found`, `source_not_supported`,
`funding_not_allowed`, `funding_conflict`, `transaction_already_reserved`,
plus the unchanged neutral intent, hash, amount, terms, and vault codes
(`intent_not_found`, `intent_unbound`, `intent_already_bound`,
`intent_state_conflict`, `invalid_hash`, `invalid_amount`, `hash_mismatch`,
`funding_terms_mismatch`, `funding_amount_unsafe`, `amount_underpaid`,
`vault_missing`). Poll-shaped codes (`campaign_not_found`,
`poll_not_public`, `forbidden`, `campaign_state_conflict`) are never emitted
by the shared engine; the Poll adapter and service boundary translates
generic results back into the existing Poll route and API vocabulary, and
the Campaign adapter translates them into Campaign route vocabulary.
Poll publicity gating lives at the Poll route and adapter pre-checks, not
inside the financial engine.

---

## 9. Public Page / Safe Reads

### 9.1 Share-link-first surface

The V2C.3 participant surface is a share-link-first route, conceptually
`/campaigns/[campaignId]`. It is reachable without prior discovery, without
an account beyond wallet verification, and without Explore. Explore and
discovery remain explicitly deferred.

Page responsibilities:

- Render Campaign product metadata (title, description, type label, window).
- Render the exact reward per participant and the exact remaining reward
  count from authoritative settlement state (L11).
- Render the derived public status: draft states are never publicly
  claimable; published/unfunded shows terms with Claim NIM disabled (L4);
  published/funded/pre-start shows "Starts at …" with Claim NIM disabled
  until `starts_at` (L18); open shows an enabled Claim NIM action; full,
  ended, or closed shows the terminal reason with Claim NIM disabled.
- Render funding readiness and publication as two separate facts (L17).
- Offer verify-wallet, claim-challenge, Claim NIM signature, and own-status
  proof flows to the connected wallet.
- Follow DESIGN.md (Soft Fog field, Clear Ballot card, Signal Gold single
  CTA, NIM Blue proof context, Verified Green only for verified completion,
  text-plus-icon status, IBM Plex Mono proof data) and brand-messaging
  vocabulary (verified, participation, reward, funded, receipt; never bet,
  wager, odds, pot, winner, prediction, or profit).

### 9.2 Public safe fields

The public read model may expose only:

- Campaign ID, campaign type (`public_giveaway`), title, description.
- Visibility marker appropriate to a share link (`public` or `unlisted`).
- Creator public identity or address exactly as approved by product policy
  (shortened form in share surfaces; full value only through approved
  truncation/copy behavior).
- Reward amount per participant (formatted NIM derived from
  `reward_per_participant_luna`).
- Maximum reward count (`max_rewarded_participants`).
- Exact remaining reward count derived as
  `max_rewarded_participants - rewarded_participant_count` from the locked
  settlement row (never a cached or client-computed estimate).
- Aggregate participation stats (for example reserved/paid counts) without
  wallet attribution.
- `starts_at`, `ends_at`, derived public status, funding-readiness boolean,
  and safe proof metadata (for example finalized payout transaction
  references already approved for public receipts).

### 9.3 Never exposed

The public surface and any authenticated non-owner read must never expose:

- claimant wallet lists or any wallet-attributed participation roster;
- challenge or nonce records, nonce hashes, or expiry internals;
- raw receipt internals beyond the viewer's own receipt;
- vault ciphertext, IV, authentication tag, or private key material;
- internal vault leases, payout retry state, or reconciliation internals;
- prepared signing bytes or unsigned/signed transaction payloads;
- private refund internals (unsigned intents, signing context, internal
  accounting drafts).

### 9.4 Own-wallet privacy

An authenticated wallet with a normal verified session may read only its own
entitlement state (L9, L12): its receipt existence, derived participant
lifecycle (Section 7.2), and its own payout/refund proof references. The
read path canonicalizes the session wallet, scopes the receipt lookup to the
(settlement, session wallet) tuple, and returns not-found without
distinguishing "Campaign empty" from "this wallet has no claim" beyond what
the public aggregate already shows. One wallet learns nothing about another
wallet's claim from this endpoint.

---

## 10. Close / Refund

### 10.1 Close semantics

Early creator close or scheduled end stops new eligibility immediately (L16).
Concretely: the product layer records `participation_campaigns.status =
'closed'` (or the window lapses past `ends_at`), and the financial layer
moves the settlement out of the reward-ready states through the existing
closure path so that the Section 4.1 predicate fails for every subsequent new
claim. Existing reservations survive close and continue through payout,
reconciliation, and finality (L7).

Close requires owner authorization from the verified session matching the
immutable Campaign and settlement owner. It never deletes receipts, never
voids reserved entitlements, and never refunds while obligations remain.

### 10.2 Refund discipline

Refund reuses the existing refund and finality engine without modification to
its safety policy:

- Refund cannot begin while obligations remain: any receipt in `reserved`,
  payout-pending, retryable, hash-bearing-unknown, or manual-review state
  blocks refund preparation until reconciled. Paid principal and confirmed
  fee accounting must reconcile before the refundable remainder is computed.
- Refund amount and destination remain server-authoritative, derived from
  immutable settlement owner/funder policy and integer-Luna accounting, never
  from browser input.
- The existing vault lease, durable pre-broadcast markers, no-blind-resend
  rule, observation of the stored refund hash, exact transfer checks, and
  macro-finality requirement before terminal `refunded` all apply unchanged.
- A zero remainder reaches the terminal refunded state without fabricating a
  refund transaction, per existing closure policy.
- Unsolicited or excess vault funds are reconciled explicitly before a
  Campaign is called safely closed; they are never silently credited, spent,
  or auto-refunded outside the accounted path.

---

## 11. Scope Decomposition

V2C.3 ships as six ordered slices. Each slice lists its exit gate; a slice
may not start its dependent work until the gate it depends on is proven. In
particular, Claim NIM UI (V2C.3E) must not ship ahead of the proven atomic
backend (V2C.3D).

### V2C.3A — Public Giveaway funding and readiness foundation

Slice A provides Campaign settlement resolution, authoritative funding
terms, vault resolution, owner authorization, funding route contracts, and
reward-readiness derivation. It intentionally cannot execute standalone
Campaign funding child-row mutation: that requires the D1 Phase 1 shared
financial-source compatibility (Section 8.3). No implementation moves back
into A.

- Campaign-branch funding intent, bind, and confirm paths adapted from the
  settlement engine: server-derived amount/vault/reference/network,
  hash-uniqueness guards, observation and finality confirmation.
- Settlement-rooted vault provisioning for standalone Campaign settlements
  (`campaign_id IS NULL`) under the existing envelope contract.
- Deterministic funding-readiness read used by creator and public surfaces.
- Configuration freeze discipline carried over from V2C.2
  (`first_reservation_at` boundary, immutable settlement linkage and owner).
- Exit gate: a configured Public Giveaway can be funded to `funded` with
  server-observed finality, and readiness reads agree with settlement state.

### V2C.3B — Public Campaign read and share-link surface

- Conceptual `/campaigns/[campaignId]` public read model with exactly the
  Section 9.2 safe fields, the L11 exact reward and remaining-count values,
  and the L17 split publication/funding facts.
- Share-link presentation (title, terms, window, status, proof strip) with no
  claimant list and no private internals.
- Authenticated own-claim read scoped to the session wallet (L9, L12).
- Exit gate: unfunded, pre-start, open, full, ended, and closed states render
  correctly from settlement truth with Claim NIM enabled only in the open
  state, and privacy probes reveal no wallet roster or private material.

### V2C.3C — Claim challenge and signature authorization

- Server-private `campaign_claim_challenges` model, deterministic
  server-created message, Campaign/wallet/action/version/nonce/time/network/
  domain binding, approximate 5-minute expiry, and fail-closed verification.
- Challenge issue gated on verified session and published Campaign, with
  courtesy pre-checks that never substitute for reservation-time authority.
- RLS and grant discipline: service-role only, security-definer transitions,
  no client reads.
- Exit gate: cross-Campaign, cross-wallet, expired, malformed, and replayed
  signatures fail closed; a valid signature verifies exactly once for its
  Campaign and wallet.

### V2C.3D — Atomic eligibility, reservation, and payout adapter

Phase 1 (shared financial-source compatibility) lands first and must be
GREEN before Phase 2:

- Shared funding RPC contract cutover per Section 8.3: `_settlement_id`
  canonical identity, generic source resolution for both branches,
  settlement-authoritative funding rows, source-neutral errors, Poll
  compatibility translation outside the engine, no surviving overload.
- Campaign-branch funding execution proven end to end (begin, replay,
  bind, confirm, finality) with `campaign_id IS NULL` rows; Poll funding
  behavior identical at its boundary.

Phase 2 (atomic participant claim) only then implements:

- The Section 6 authoritative claim transaction: binding resolution, ordered
  locks, challenge recheck, existing-receipt replay before capacity,
  full eligibility recheck, receipt creation with counter and lifecycle
  transition, `first_reservation_at` handling, and same-commit challenge
  consumption.
- Thin `CampaignRewardParticipationAdapter` for `public_giveaway` returning
  the existing minimal `RewardParticipationContext` shape; all amount,
  capacity, vault, and lifecycle authority stays in the locked settlement
  rows.
- Handoff to the unchanged automatic payout, reconciliation, and finality
  path.
- Exit gate: duplicate same-wallet races yield one receipt, final-slot races
  yield one winner with a typed no-capacity result for the loser, retries
  replay the existing receipt, creator self-claims are rejected at both
  layers, and close/expiry races resolve to either durable reservation or
  clean rejection with no torn state.

### V2C.3E — Participant Claim NIM UX and durable status

- Claim NIM action (L1) wired to challenge → signature → Section 6
  reservation, available only when the derived read model reports open.
- Reservation-first copy (L2): success states the entitlement belongs to the
  wallet even while payout is pending.
- Durable status surface derived from Section 7.2 (reserved, sending,
  confirming, paid, payout-delayed) with proof references and no retry-send
  control (L8).
- Own-status reads over the normal verified session without a second claim
  signature (L9).
- DESIGN.md and brand-messaging compliance: Signal Gold single CTA, NIM Blue
  proof context, Verified Green only for verified completion, text-plus-icon
  status, no betting or pot language.
- Exit gate: a participant can complete signed claim → reservation → paid
  proof from the share link, survive reload and session expiry within the
  session policy, and see accurate delayed-state copy when payout lags.

### V2C.3F — Close and Refund plus complete vertical-slice gate

- Early creator close, scheduled-end handling, and the Section 10 obligation
  and refund discipline over the existing closure/refund engine.
- Full synthetic end-to-end gate per Section 13: create → configure → fund →
  funding finality → publish/share → signed claim → receipt reservation →
  payout → finality → Paid proof → second claim → creator closes early → new
  claim rejected → obligations settle → unused remainder refunded → terminal
  closure.
- Exit gate: the E2E lifecycle completes with Poll backward-compatibility
  green, privacy probes green, and no second ledger, no Campaign payout
  duplication, and no unresolved obligation at refund time.

---

## 12. Deferred (Explicitly Out of V2C.3)

The following are not designed, planned, or built by V2C.3:

- Explore and discovery surfaces.
- Public claimant lists or wallet-attributed leaderboards.
- Secret Drop, including secret verifiers and secret storage.
- Private Drop, including allowlist storage and membership checks.
- Event Drop, including event proofs and QR or deep-link transport.
- Community Reward, including membership sets (distinct from settlement
  `funding_mode = 'community'`, which remains a funding-wallet choice only).
- A generic eligibility framework spanning all Campaign types.
- Reward assets other than NIM.
- Chains or networks other than the approved Nimiq path.
- Human, KYC, or Sybil identity claims. One Campaign plus one canonical
  wallet is an identity boundary for duplicate prevention, not a proof of
  unique humanness.
- Participant manual payout retry or participant-side broadcast controls.
- Any change to Poll creation, voting, automatic payout, or receipt semantics.

---

## 13. Testing Strategy

Coverage is specified here as required gates for the implementing slices. No
test is implemented by this document.

1. **Claim challenge and signature security:** valid signature verifies;
   cross-Campaign, cross-wallet, wrong action/version, malformed, expired,
   and replayed signatures fail closed; raw nonces are never stored and
   challenge rows are never readable by anon or authenticated roles.
2. **Eligibility:** each Section 4.1 condition is tested in isolation and in
   combination, including unpublished, pre-start, post-end, manually closed,
   unfunded, wrong-type, and zero-capacity Campaigns.
3. **Duplicate and idempotent claims:** second claim by the same wallet
   returns the existing receipt without consuming capacity or creating a
   second payout lineage.
4. **Final-slot concurrency:** two wallets racing the last slot produce
   exactly one reservation and one typed no-capacity result; counters never
   exceed the cap under concurrent load.
5. **Creator exclusion:** owner-wallet claims are rejected by the adapter
   pre-check and independently by the atomic transaction, including
   case-variant and alternate-representation owner addresses canonicalized to
   the same wallet.
6. **Funding readiness:** published-but-unfunded Campaigns reject claims;
   readiness reads agree with settlement state through the funding lifecycle.
7. **Scheduled start and end:** pre-start claims are rejected with a
   starts-at presentation; post-start claims proceed without operator action;
   post-end claims are rejected while pre-end reservations survive.
8. **Early close:** post-close new claims are rejected; pre-close
   reservations survive and remain payable.
9. **Durable reservation:** reservation-first semantics hold across payout
   delay, process restart, and reconciliation lag; the entitlement is never
   voided by close, expiry, or payout latency.
10. **Payout, reconciliation, and finality:** exact sender, recipient,
    amount, network, execution, canonical inclusion, and macro-finality
    checks gate the `paid` transition; hash-bearing uncertainty is never
    blindly resent; bounded hashless retry and manual-review paths behave per
    existing policy.
11. **Public privacy:** anonymous and authenticated non-claimant reads reveal
    aggregates only; probing for claimant wallets, challenges, receipts,
    vault material, leases, signing bytes, or refund internals yields nothing.
12. **Own-wallet status privacy:** a connected wallet reads exactly its own
    claim state over its verified session; cross-wallet reads fail closed
    without oracle behavior.
13. **Funding security:** wrong sender, wrong recipient, wrong amount, wrong
    network, reused hash, and pre-finality confirmation attempts are
    rejected; browser-supplied economics are ignored.
14. **Refund and closure:** refund is blocked while any reserved,
    payout-pending, retryable, unknown, or manual-review obligation exists;
    accounting reconciles before the remainder is computed; amount and
    destination are server-derived; terminal `refunded` requires final chain
    proof.
15. **Poll backward compatibility:** Poll creation, voting, reward-first
    gating, vote-before-reward ordering, automatic Claim-free payout,
    receipts, and public Poll shapes remain green throughout V2C.3.
16. **RLS and private-table security:** anon and authenticated roles hold no
    access to settlements, bindings, challenges, financial children, or
    vaults; security-definer functions enforce owner, binding, and lifecycle
    checks independent of caller claims.
17. **Full synthetic end-to-end Public Giveaway lifecycle:** one scripted run
    covers create → configure → fund → funding finality → publish/share →
    signed claim → receipt reservation → payout → finality → Paid proof →
    second claim (replay) → creator closes early → new claim rejected →
    obligations settle → unused remainder refunded → terminal closure.

---

## 14. RLS / Private-Table Security

- Enable RLS and revoke `anon` and `authenticated` access on
  `campaign_claim_challenges` (conceptual name for the implementing slice)
  and on every existing private table it touches through the claim path:
  `reward_settlements`, `settlement_source_bindings`,
  `participation_campaigns` owner and private configuration reads,
  `reward_funding_transactions`, `reward_receipts`, `reward_payout_attempts`,
  `reward_refunds`, and `reward_campaign_vaults`.
- Grant only the minimum service-role access required by server stores and
  security-definer transitions. No client reads private rows directly; all
  participant and public views pass through explicit server read models with
  the Section 9 field allowlists.
- Challenge verification and the Section 6 claim transaction run as
  security-definer with fixed `search_path`, deterministic lock ordering, and
  canonical wallet handling. They never trust client-supplied amounts,
  capacity, vault addresses, settlement status, or eligibility booleans.

---

## 15. Poll Backward Compatibility

V2C.3 changes no Poll behavior:

- Poll vote remains vote-first with reward follow-up that never invalidates a
  valid vote.
- Poll automatic payout remains automatic and Claim-free; the Claim NIM
  action exists only on the Campaign share-link surface.
- `reward_campaigns.poll_id NOT NULL UNIQUE`, Poll adapter ownership checks,
  reward-first gating (`economic_model = 'reward_first'`, `reward_mode =
  'rewarded'`), creator-vote reward ineligibility, and legacy-support
  separation all remain authoritative.
- Existing receipt, funding, payout, and refund IDs, hashes, and public
  response aliases remain stable. Settlement-rooted reads for Polls resolve
  through the Poll binding branch and never through a Campaign row.
- Poll funding routes and services keep their exact request, response, and
  error vocabulary; the shared engine's source-neutral results are
  translated at the Poll boundary, and Poll publicity gating stays at the
  Poll route and adapter pre-checks.

---

## 16. Spec Self-Review Log

Reviewed before commit for placeholders, contradictions, second-ledger risk,
payout duplication, idempotency ambiguity, challenge-ordering ambiguity,
missing concurrency semantics, published/funded/claimable confusion, privacy
leakage, scope creep, and V2C.2 conflicts. Findings and fixes applied in this
document:

1. **No placeholders:** no TBD, TODO, placeholder, or undecided field
   remains. Challenge TTL is fixed at approximately 5 minutes, the message
   binding list is fixed, the transaction step order is fixed, and the slice
   gates are fixed.
2. **No second financial ledger:** an early draft risked implying a Campaign
   claim-status table alongside receipts. Fixed by making `reward_receipts`
   the sole durable entitlement (Section 7.1) and by permitting a new table
   only under an explicit impossibility proof that the default design does
   not need.
3. **No Campaign payout duplication:** payout, reconciliation, retry,
   finality, vault lease, and refund execution stay in the existing
   `RewardSettlementService` and closure path. The Campaign adapter returns
   only the minimal participation context and never signs or broadcasts.
4. **Claim idempotency fixed:** the idempotency key is the durable tuple
   (settlement, canonical wallet), distinct from single-use challenge
   nonces. Replay returns the existing receipt; nonce reuse fails closed.
   Both rules are stated together so they cannot be read as contradictory.
5. **Challenge-consumption ordering fixed:** consumption and reservation
   commit together in one transaction. The document explicitly forbids
   independent commits and defines the duplicate path as consume-if-fresh
   plus return-existing-receipt in the same commit.
6. **Concurrency semantics completed:** same-wallet races, last-slot races,
   HTTP-uncertainty retries, and close-versus-claim races each have a
   specified winner and loser outcome. Capacity checks sit under the
   settlement lock with the check constraint as final guard.
7. **Published, funded, and claimable separated:** Section 4.3 gives the
   three terms disjoint definitions, and Sections 4.2, 8, and 9 use them
   consistently. Published-but-unfunded stays viewable with Claim NIM
   disabled; scheduled starts need no stored flag.
8. **Privacy leakage closed:** Section 9.3 lists never-exposed fields
   (challenges, nonces, leases, signing bytes, refund internals, claimant
   roster) and Section 9.4 scopes own-wallet reads to the session-wallet
   tuple without oracle behavior.
9. **Scope creep removed:** other Campaign types, Explore, other assets,
   other chains, KYC/Sybil, and manual payout retry are enumerated as
   deferred in Section 12, and Section 3.3 rejects the generic eligibility
   framework for V2C.3.
10. **V2C.2 conflicts cleared:** settlement as sole mutable authority,
    settlement-rooted vaults with unchanged AAD bytes, Poll compatibility,
    and the no-stored-`claimable` rule from V2C.2 are reaffirmed in Section
    3.2 and referenced by every dependent section. The conceptual challenge
    table name is marked conceptual so it cannot collide with the shipped
    V2C.2 schema.
11. **Shared funding contract fixed:** one funding engine serves Poll and
    Campaign under `_settlement_id` canonical identity (Section 8.3), with
    no `begin/bind/confirm_campaign_funding_atomic` fork and no surviving
    Poll-shaped overload. Funding rows carry `settlement_id` authority with
    `campaign_id` as nullable Poll metadata and no
    `participation_campaign_id` column. Generic errors stay inside the
    engine; Poll and Campaign wording is translated at the adapter and
    service boundaries.

---

## 17. Non-Implementation Statement

This document is a design specification. It creates no migrations, APIs,
application code, tests, implementation plans, or participant flows. It starts
no V2C.3 implementation slice, touches no hosted Supabase instance, and sends
no NIM. The next step, when authorized, is V2C.3A scoped by Section 11.
