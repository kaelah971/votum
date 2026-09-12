# V2C.1 Shared NIM Participation Engine Design

**Status:** Design specification only. This document does not modify production
code, add schema, add migrations, add routes, add Campaign UI, start Docker,
mutate Supabase, send NIM, deploy, or merge `main`.

**Branch:** `feat/v2-participation-record`

**Latest verified regression-gate commit:** `2b65d4f fix(v2b2): harden reward compatibility boundaries`

**Primary evidence:**

- `docs/superpowers/reviews/2026-09-12-v2c0-campaign-integration-readiness-audit.md`
- `docs/superpowers/specs/2026-08-22-v2b2-rewarded-participation-design.md`
- `docs/superpowers/specs/2026-08-31-v2b2-reward-first-product-alignment-design.md`
- `docs/superpowers/plans/2026-08-31-v2b2-reward-first-product-alignment-implementation.md`
- V2B.2.13 regression hardening migration and tests in the latest commit

The V2C.0 audit was performed at an earlier `f40e142` HEAD. This specification
uses the current repository as the authority: the latest branch includes the
V2B.2.13 compatibility hardening and the V2B.2 closure/refund execution slices
that were not present in that audit snapshot.

## 1. Goal / Non-Goals

### Goal

V2C.1 defines the smallest safe internal boundary for a shared NIM financial
engine that consumes authoritative, verified participation eligible for a
predefined reward.

The target product relationship is:

```text
poll_vote
  -> Poll reward participation adapter
  -> shared reservation engine
  -> shared settlement engine
  -> shared closure/refund engine

future campaign_claim
  -> future Campaign adapter
  -> the same reservation engine
  -> the same settlement engine
  -> the same closure/refund engine
```

The shared engine must not know whether eligibility came from a Poll vote, a
secret, an allowlist, an event proof, or a future community membership set. It
must know only the server-derived participation identity, eligibility evidence,
settlement identity, exact reward terms, vault identity, capacity, and lifecycle
state required to make a safe reservation or settlement transition.

### Non-goals

- Do not turn Polls into Campaigns.
- Do not create `participation_campaigns` in V2C.1.
- Do not make `reward_campaigns.poll_id` nullable.
- Do not create a nullable Poll/Campaign mega-table.
- Do not duplicate the NIM funding, vault, payout, reconciliation, or refund engine.
- Do not implement a Campaign entity, Campaign claim flow, or Campaign routes.
- Do not change Poll creation, discovery, voting, receipts, or visible UX.
- Do not change Poll automatic payout behavior.
- Do not add a Claim button to Polls.
- Do not add secret, allowlist, event, or community eligibility storage.
- Do not change current reward economics, fee policy, finality policy, or refund policy.
- Do not infer eligibility, amount, recipient, capacity, owner, or vault from a browser request.

## 2. Current Engine Map

### 2.1 Product and source records

The current source-of-participation records are Poll records, not generic
Campaign claims.

| Record | Current authority | Shared-engine implication |
|---|---|---|
| `polls` | Poll question, creator, public visibility, Poll status, economic discriminator, reward mode, and Poll window | Remains Poll-specific. The adapter reads it to decide whether a Poll can produce a reward candidate. |
| `poll_votes` | Durable verified participation result with `poll_id`, `option_id`, `voter_wallet`, and `created_at` | `id` is the Poll adapter's durable source evidence. `option_id` is never passed into the reward engine. |
| `poll_options` | Poll option identity and labels | Remains entirely outside the reward engine. |
| `wallet_sessions` | Hashed session-cookie identity, canonical wallet address, expiry, and revocation | Shared authentication primitive. A session proves wallet control, not Campaign eligibility by itself. |

`cast_poll_vote_atomic` is a service-role-only security-definer function. It
validates the Poll window, validates that the option belongs to the Poll, and
enforces one wallet per Poll through the Poll uniqueness constraint and an
advisory lock. It returns a durable vote ID.

The Poll `POST /api/polls/[pollId]/vote` route first obtains
`getVerifiedWalletSession()`, then calls `cast_poll_vote_atomic`. A successful
vote is committed before reward work begins. Reward reservation and automatic
payout are best-effort follow-up work: a reservation or payout failure is
logged and does not turn a valid Poll vote into a failed vote.

### 2.2 Reward financial records

The current V2B.2 records are all financial records attached to a Poll-bound
`reward_campaigns` row.

| Record | Actual fields and behavior | Current Poll coupling |
|---|---|---|
| `reward_campaigns` | One row per reward offer; exact per-participant Luna amount, cap, principal, fee reserve, total budget, funding mode/wallet, status, funded/paid/refundable balances, `first_reservation_at`, timestamps, and payout lease fields | `poll_id uuid NOT NULL UNIQUE REFERENCES polls(id)`. This is a Poll reward adapter record, not the future Campaign product entity. |
| `reward_funding_transactions` | Funding intent and hash lifecycle; reference, amount snapshot, funding/funder wallet snapshots, vault recipient, principal/fee snapshots, submitted/confirmed hashes, deadline, observation fields, and status | `campaign_id` resolves through a Poll-bound `reward_campaigns` row. Current funding RPCs also verify public Poll state. |
| `reward_receipts` | One reward entitlement per campaign and participant wallet; exact `amount_luna`, receipt status, `poll_id`, and `paid_at` | Has both `campaign_id` and `poll_id` foreign keys. It intentionally has no `option_id`, option label, or vote payload. |
| `reward_payout_attempts` | Attempt number, receipt relation, prepared signed bytes/hash, sender/recipient/amount/fee/network/validity snapshot, broadcast markers, retry/error status, and finality evidence | Resolves its campaign through `reward_receipts`. The current attempt schema has no direct generic settlement ID. |
| `reward_refunds` | Immutable refund amount and creator destination, prepared transaction/hash, broadcast markers, error status, and finality evidence | `campaign_id` resolves through a Poll-bound reward campaign. The current refund preparation also validates the related Poll closure. |
| `reward_campaign_vaults` | Exactly one isolated vault per reward campaign; public address plus AES-256-GCM encrypted private key envelope | `campaign_id` is the primary key and foreign key. The current service and naming are campaign-shaped even though the parent row is Poll-bound. |

### 2.3 Funding initiation and confirmation

The current funding path is:

```text
verified funding wallet session
  -> Poll-scoped funding intent route
  -> reward_campaigns.funding_wallet authorization
  -> begin_reward_funding_atomic
  -> intent with server-derived amount, memo/reference, and vault
  -> Nimiq Pay transfer outside the server
  -> Poll-scoped bind route with client callback hash
  -> bind_reward_funding_transaction_atomic
  -> funding_pending / submitted
  -> Poll-scoped confirm route
  -> getTransactionByHash plus finality observation
  -> reconcileRewardFunding
  -> confirm_reward_funding_atomic
  -> funded
```

The browser may return a transaction hash after the wallet flow, but the hash
does not confirm funding. The confirmation route loads the stored intent,
campaign, and vault context. `reconcileRewardFunding` checks the observed hash,
network, vault recipient, memo when required, execution result, amount, and
finality. The atomic confirmation function loads the persisted terms and marks
the campaign funded only after server-produced observation is accepted.

Funding uses integer Luna. The amount is derived from persisted campaign terms;
the client cannot choose the principal, fee reserve, total, vault, or campaign.
Funding hash binding is idempotent and guarded against reuse across the funding,
payout, refund, and historical support ledgers.

### 2.4 Reservation and automatic Poll payout

The current Poll reward path is:

```text
verified Poll vote
  -> cast_poll_vote_atomic
  -> returned poll_votes.id
  -> lookup reward_campaigns by poll_id
  -> claim_reward_receipt_atomic(vote_id, campaign_id)
  -> reward_receipts.status = reserved
  -> rewarded_participant_count increment
  -> first_reservation_at set once
  -> begin_reward_payout_atomic
  -> server vault signing and durable preparation
  -> broadcast-start marker
  -> server broadcast
  -> payout reconciliation by stored hash
  -> canonical and macro finality proof
  -> confirm_reward_payout_atomic
  -> reward_receipts.status = paid
```

`claim_reward_receipt_atomic` currently locks the campaign row, loads the vote,
loads the Poll, checks public live/closed Poll state, checks the Poll economic
model and reward mode, checks campaign ownership, checks funded/rewarding state,
checks capacity, excludes the Poll creator, inserts the receipt, increments the
counter, and sets `first_reservation_at` atomically.

The latest V2B.2.13 hardening requires the Poll to be explicitly
`economic_model = 'reward_first'` and `reward_mode = 'rewarded'`. This prevents
legacy support and free reward-first Polls from creating reward obligations.

The pure helper in `src/lib/rewards/eligibility.ts` still contains a historical
branch that treats a non-null campaign as rewardable for a legacy Poll. That
helper must be narrowed or isolated during implementation. The latest SQL and
regression gate are the compatibility authority; the legacy helper branch must
not become the generalized adapter rule.

### 2.5 Payout signing, broadcast, and finality

`runRewardPayout` and `executeReservedRewardPayout` use a `RewardPayoutStore`
backed by the reward RPCs. The store and service enforce the following order:

1. Atomically claim one reserved receipt and create or replay one payout attempt.
2. Acquire the campaign's durable vault lease because the network call outlives a database transaction.
3. Load the recipient and amount from the receipt and the sender from the vault.
4. Sign a basic NIM transaction server-side with the isolated vault key.
5. Persist the exact signed bytes, transaction hash, sender, recipient, amount, fee, network, and validity height before network contact.
6. Persist `broadcast_started_at` before calling `sendTransaction`.
7. Persist the matching broadcast hash only after a successful callback.
8. Treat a hash-bearing or broadcast-started uncertain outcome as unknown and never blindly resend it.
9. Permit a new attempt only for a definite hashless pre-broadcast failure, bounded by the existing retry limit.
10. Reconcile by observing the stored hash and require exact sender, recipient, amount, network, successful execution, canonical micro-block inclusion, batch, and finalizing macro-block evidence before `paid`.

`withCampaignVaultKey` decrypts the key only inside a tightly scoped callback,
checks the derived address against the persisted vault address, and disposes
key material after signing. The vault key never leaves the server or appears in
an outward response.

### 2.6 Closure and refund

The current closure/refund path is now implemented across the V2B.2.11 slices:

```text
Poll closure/expiry or creator cancellation policy
  -> begin_reward_refund_atomic with hashed verified session identity
  -> campaign lock
  -> source Poll closure check
  -> unresolved receipt and payout-reconciliation checks
  -> confirmed paid/fee accounting checks
  -> exact refundable remainder calculation
  -> closed -> refunding freeze
  -> durable refund intent
  -> same-vault lease
  -> server signing and durable preparation
  -> broadcast-start marker
  -> broadcast callback
  -> refund observation and finality
  -> confirm_reward_refund_atomic
  -> confirmed refund proof
  -> refunding -> refunded terminal state
```

`src/lib/rewards/refund-policy.ts` is already a useful source-independent pure
policy boundary. It classifies unresolved obligations, identifies payout
reconciliation requirements, verifies integer-Luna accounting, and caps the
ledger-refundable amount at the observed vault balance. It does not sign,
broadcast, or mutate state.

The database closure RPC owns the atomic Poll-bound transition today. It uses a
verified session token hash, derives the creator from the reward campaign and
Poll, validates the Poll closure condition, locks the campaign, blocks
unresolved obligations, checks paid receipts and confirmed fees, creates one
frozen refund intent, and transitions to `refunding`.

Refund execution uses the same server custody and irreversible-boundary rules
as payout. A confirmed refund requires exact hash, sender, creator recipient,
amount, network, execution, canonical inclusion, and macro finality. The
campaign cannot reach `refunded` without confirmed refund proof. Receipts and
payout attempts are blocked after the refund freeze.

`first_reservation_at` is the durable one-time marker for the first reward
obligation. Current application configuration is mutable only while the reward
campaign is `configured`; reservation moves the campaign into `rewarding` or
`exhausted`; closure/refund triggers add stronger terminal freeze guards. The
generalized implementation must preserve this boundary and must not rely on a
client or a stale context to enforce it.

### 2.7 Wallet verification

The existing wallet proof flow is shared identity infrastructure:

1. The challenge route validates same-origin requests and a canonical wallet.
2. It stores a five-minute challenge message with nonce, domain, wallet, issue time, and expiry.
3. The verify route checks challenge expiry/use, address canonicalization, public-key-derived address, and signature.
4. It atomically consumes the challenge and creates a 12-hour session with a SHA-256 token hash.
5. `getVerifiedWalletSession` checks the hashed cookie, expiry, revocation, and stored wallet identity.

This proves control of a wallet and authenticates a server request. It does not
prove Campaign claim eligibility. The current challenge message has no
Campaign ID, claim purpose, or durable claim nonce and must not be reused
unchanged for future Campaign claims.

## 3. Architectural Decision

Adopt:

```text
shared engine contracts
  + explicit Poll compatibility adapter
  + future Campaign adapter contract
```

Polls remain Polls. A future `participation_campaigns` entity remains a separate
first-class product entity. Existing `reward_campaigns` rows remain the
Poll-backed financial adapter for the current product until a later additive
financial binding is designed and implemented.

### 3.1 Proposed internal names

Use the repository's existing `Reward...` naming convention:

- `RewardParticipationContext`: server-produced source and settlement snapshot used by the shared reservation boundary.
- `RewardParticipationSourceType`: `poll_vote` or `campaign_claim`.
- `RewardParticipationAdapter`: source-specific resolver that produces a context or a typed ineligibility result.
- `RewardReservationService`: shared uniqueness, capacity, amount-authority, first-reservation, and atomic reservation boundary.
- `RewardSettlementContext`: source-independent funding, vault, payout, observation, and finality context.
- `RewardSettlementService`: shared funding, payout execution, reconciliation, retry, and idempotency orchestration.
- `RewardClosureContext`: source-independent closure, obligations, accounting, and refund input.
- `RewardClosureService`: shared close, refund preparation, broadcast, reconciliation, and terminal-freeze orchestration.

These are design names only. They are not implemented by this document.

### 3.2 Smallest shared participation contract

The smallest useful adapter output is a server-only `RewardParticipationContext`:

```ts
type RewardParticipationSourceType = "poll_vote" | "campaign_claim";

interface RewardParticipationContext {
  source: {
    type: RewardParticipationSourceType;
    id: string;
  };
  participantWallet: string;
  ownerWallet: string;
  eligibility: {
    evidenceId: string;
    evidenceKind: "verified_wallet_vote" | "verified_wallet_claim";
    verifiedAt: string;
  };
  settlement: {
    id: string;
    rewardAmountLuna: bigint;
    capacity: {
      maxParticipants: number;
      reservedParticipants: number;
    };
    vaultAddressHex: string;
    state: RewardCampaignState;
    firstReservationAt: string | null;
  };
  lifecycle: {
    participationOpen: boolean;
    sourceClosed: boolean;
  };
}
```

The exact TypeScript placement and field casing may follow the implementation's
module layout, but these meanings are fixed.

The context is a server-produced snapshot, not a client-authoritative command:

- `source.type` and `source.id` identify durable source evidence, never an arbitrary browser assertion.
- `participantWallet` comes from a verified session and the authoritative source row, then is canonicalized and cross-checked.
- `ownerWallet` comes from the immutable source owner and is checked against the settlement owner.
- `eligibility.evidenceId` points to durable server evidence. `verifiedAt` records the server decision time, not a client timestamp.
- `settlement.id` is an opaque financial settlement identity. In V2C.1 it is the current `reward_campaigns.id`; it is not the Poll ID.
- `rewardAmountLuna`, capacity, vault, state, and `firstReservationAt` are loaded from the database by the server. They may be included in the context for service composition, but the reservation transaction reloads and verifies them before committing.
- `lifecycle` distinguishes source participation timing from settlement state. A source may be closed while already-reserved obligations still settle.

No browser payload may construct or serialize this interface for direct use. A
server route may receive only an untrusted source identifier, Poll option ID,
opaque claim evidence, or wallet callback. The adapter must resolve that input
into this context using server-side reads and policy.

### 3.3 Authority layering

The context is the handoff contract, not the final authority. The authority
layers are:

1. Wallet session proves control of the canonical participant or authorized operator wallet.
2. The source adapter proves source-specific participation and eligibility from durable source evidence.
3. The reservation engine reloads the settlement row and rechecks owner, amount, capacity, vault, source binding, and lifecycle under the settlement lock.
4. The settlement engine reloads receipt, attempt, funding, refund, and vault records before every irreversible or terminal transition.
5. The database security-definer transition remains the atomic authority for the state mutation.

This permits a stale or internally malformed context to fail closed. It also
prevents a future adapter from becoming an alternative money ledger.

## 4. Alternatives Considered

### A. Generalize `reward_campaigns` directly

Rejected. Making `poll_id` nullable and adding source/type branches would mix a
Poll adapter record with a future product entity. It would weaken existing
foreign-key guarantees, force every current RPC to branch on missing Poll data,
and make legacy support compatibility a permanent nullable case. It would also
make a financial row appear to be the product Campaign when it is currently a
Poll reward offer.

### B. Duplicate the financial engine for Campaigns

Rejected. A second Campaign funding, signing, broadcast, reconciliation, retry,
and refund stack would create two sources of money-safety behavior. Fixes for
hash reuse, finality, duplicate sends, or vault concurrency could diverge.

### C. Keep all logic Poll-specific and add a future separate engine

Rejected. This preserves current behavior but fails the product requirement to
make one proven financial primitive reusable. It would make Campaigns likely to
reimplement the exact unsafe edges V2B.2 was designed to close.

### D. Shared contracts with explicit adapters

Recommended. Source adapters own participation and eligibility. Shared services
own financial obligations and chain settlement. Poll rows remain authoritative
for Poll behavior, and future Campaign identity can be added without changing
Poll semantics or introducing a nullable mega-row.

## 5. Shared Source-Adapter Contract

### 5.1 Responsibilities

Every source adapter owns:

- source-specific definition of participation;
- source-specific eligibility evidence and validation;
- canonical participant identity;
- immutable source owner identity;
- self-participation policy;
- source lifecycle and whether a new obligation may be created;
- durable evidence ID and the source-to-settlement binding;
- fail-closed handling for malformed, missing, expired, replayed, or mismatched evidence.

Every adapter must not own:

- reward amount calculation from browser input;
- capacity counters;
- vault key material or signing;
- funding confirmation;
- payout or refund hashes;
- paid/refunded terminal state;
- direct writes that bypass the shared reservation or settlement boundary.

### 5.2 Contract shape

The proposed server-only contract is conceptually:

```ts
interface RewardParticipationAdapter<TRequest> {
  resolveParticipation(
    request: TRequest,
  ): Promise<
    | { kind: "eligible"; context: RewardParticipationContext }
    | { kind: "ineligible"; reasonCode: string; sourceId?: string }
  >;
}
```

The request type is source-specific and must contain a verified server session,
not a wallet string asserted by the browser. Any opaque evidence remains
untrusted until parsed, bound to the source, checked for expiry/replay, and
recorded or resolved server-side.

### 5.3 Required invariants

An adapter may return `eligible` only when all of these are true:

- the participant wallet is canonical and is the wallet authenticated by the server session;
- the source evidence exists and belongs to the requested source;
- the source evidence is committed and has not already been consumed in a conflicting way;
- the source owner, settlement owner, and adapter policy agree;
- source-specific eligibility is true without relying on a client boolean;
- the settlement is the intended reward ledger for this source;
- the settlement state permits a new reservation candidate;
- the adapter can identify the exact reward amount and vault snapshot loaded from server authority;
- no selected option or source-private payload is copied into the shared context.

The adapter may return an ineligible result for no capacity, a closed source,
creator self-participation, an unfunded settlement, a duplicate, or a source
policy failure. The shared engine must preserve enough result detail for the
source route to keep its existing UX semantics without exposing internal
financial data.

## 6. Poll Adapter Design

### 6.1 Adapter identity

The explicit Poll implementation is `PollRewardParticipationAdapter`. It is a
compatibility adapter, not a Campaign adapter and not a replacement for Poll
voting.

Its source type is `poll_vote`. Its durable source ID is `poll_votes.id`. Its
settlement ID is the attached `reward_campaigns.id`.

### 6.2 Server-derived Poll inputs

After `cast_poll_vote_atomic` returns a successful `vote_id`, the adapter must:

1. Load `poll_votes` by `vote_id` and require the row's `poll_id` to equal the route Poll ID.
2. Load the verified session from the server and require its canonical wallet to equal the vote's canonical participant wallet.
3. Load `polls` by the vote's `poll_id` and derive the immutable Poll creator wallet and Poll lifecycle.
4. Require `is_public = true` and a Poll state/window that permits the current V2B.2 reward rule.
5. Require `economic_model = 'reward_first'` and `reward_mode = 'rewarded'`.
6. Load exactly one `reward_campaigns` row by `poll_id` and require its Poll binding, owner, funding terms, and lifecycle to be consistent.
7. Load the isolated vault public address from `reward_campaign_vaults` by the settlement ID.
8. Derive the amount, cap, reserved count, settlement state, and `first_reservation_at` from the locked financial rows.
9. Apply the Poll self-participation rule: the creator may vote, but cannot receive a reward.
10. Return a context containing the vote ID as evidence and no option data.

The adapter must not accept reward amount, cap, owner, vault, `eligible`, or
recipient values from the request body. It must not use `option_id` to choose a
reward amount or to create a reward receipt.

### 6.3 Poll-specific eligibility

The adapter owns these Poll rules:

- a valid Poll vote is the participation event;
- Poll voting remains one verified wallet per Poll;
- Poll creator participation is valid but self-reward is ineligible;
- private Polls are not rewardable;
- legacy support Polls are not reward-first rewards;
- free reward-first Polls create no reward obligation;
- only a rewarded reward-first Poll with an eligible source vote can enter the shared reward boundary;
- a Poll that is closed cannot accept a new vote, while a previously reserved reward can continue settling under the financial lifecycle;
- the Poll option may be recorded by the Poll system but is irrelevant to reward economics.

The latest `2b65d4f` SQL hardening is the non-negotiable rule for the adapter.
The old `evaluateRewardEligibility` legacy branch that treats any non-null
campaign as rewardable must be removed, split, or kept outside the generalized
Poll adapter during implementation. It must not make a legacy support row enter
the shared reward engine.

### 6.4 Poll behavior after adaptation

The visible Poll path remains:

```text
verified wallet -> choose option -> vote recorded -> automatic reward attempt
```

There is no Poll Claim action. The vote route returns its existing vote response
as soon as the vote transaction succeeds. Reservation, payout, and
reconciliation remain server-side follow-up work. A financial failure is logged,
reconciled, or surfaced through the existing creator/receipt surfaces; it does
not invalidate a valid vote.

## 7. Shared Reservation Boundary

### 7.1 Responsibilities

`RewardReservationService` owns:

- one canonical participant identity per settlement;
- one durable reward receipt per eligible participant;
- capacity and final-slot concurrency;
- authoritative reward amount loading;
- source-to-settlement relationship validation;
- owner/self-reward defense in depth;
- the one-time `first_reservation_at` boundary;
- atomic receipt insert, counter update, and settlement-state transition;
- replay-safe result handling.

It does not own the definition of source participation, option validity,
secret parsing, allowlist membership, payout signing, or chain observation.

### 7.2 Reservation algorithm

The shared boundary should perform this sequence in one database transaction or
through a security-definer RPC that has the same atomic semantics:

1. Validate that the request came from a server-produced context and has a non-empty settlement ID and source evidence ID.
2. Lock the authoritative settlement row using the same deterministic lock convention as the current campaign reservation.
3. Reload the settlement record, source binding, owner, vault, terms, capacity, lifecycle, and first-reservation timestamp.
4. Compare the reloaded owner, participant, settlement ID, vault, amount, and source relationship with the adapter context. Reject mismatches.
5. Recheck source evidence and source-specific eligibility, or call the adapter before entering the atomic section where appropriate.
6. Reject legacy support and free Poll records through the Poll adapter and database defense-in-depth.
7. Reject configured, funding-pending, cancelled, closed, or refunded settlements unless an explicit source-neutral policy says they are only replayable.
8. Return a durable replay for an existing canonical participant receipt before evaluating remaining capacity.
9. Enforce remaining capacity under the settlement lock.
10. Insert a receipt with the exact server-loaded amount and participant identity, increment the reserved count, set `first_reservation_at` if null, and transition to `rewarding` or `exhausted` atomically.
11. Return `reserved`, `replay`, `no_capacity`, or a typed ineligible result without exposing private settlement fields.

The current V2B.2 SQL already implements most of this for Poll votes. V2C.1
should first extract the application/domain boundary around that behavior rather
than immediately replacing the Poll-bound SQL with a speculative generic RPC.

### 7.3 Authority and uniqueness

The amount is never taken from the context as final authority. The authoritative
amount is the locked settlement row. The context amount is a consistency check.
The same applies to capacity, vault, owner, and lifecycle.

The current database constraint is `UNIQUE (campaign_id, participant_wallet)`
on raw stored text, while the RPC also performs lower/trim comparisons. This is
adequate for the current canonical route path and is covered by V2B.2.13, but it
is not a complete database invariant for arbitrary direct service-role writes.
V2C.1 must preserve current behavior and document this limitation; V2C.2 or
the first Campaign financial binding must make canonical wallet storage or
canonical uniqueness database-enforced before arbitrary Campaign claims exist.

### 7.4 Poll adapter integration

The Poll route continues to call the Poll vote RPC first. The adapter then
resolves the returned vote. The reservation service can initially use a Poll
compatibility store that calls `claim_reward_receipt_atomic`, because that RPC
still derives the wallet, Poll, campaign, amount, owner, and capacity itself.

The extraction is safe only if:

- the Poll adapter's source evidence is validated before the call;
- the existing SQL remains the final financial authority;
- the successful vote is never rolled back because reward work fails;
- the existing `reward_campaigns.poll_id` relationship is not generalized by making it nullable;
- all V2B.2.13 result semantics remain unchanged.

## 8. Shared Settlement Boundary

### 8.1 Settlement context

The shared financial services need a source-independent context separate from
the participation context:

```ts
interface RewardSettlementContext {
  settlementId: string;
  ownerWallet: string;
  fundingWallet: string;
  vaultAddressHex: string;
  networkId: number;
  rewardPerParticipantLuna: bigint;
  rewardPrincipalLuna: bigint;
  feeReserveLuna: bigint;
  totalBudgetLuna: bigint;
  fundedAmountLuna: bigint;
  paidAmountLuna: bigint;
  feeSpentLuna: bigint;
  refundableExcessLuna: bigint;
  state: RewardCampaignState;
  firstReservationAt: string | null;
}
```

This is a service-loaded snapshot, not an API request type. It should be built
from a source-neutral financial binding in the future. In V2C.1 it is built from
the current `reward_campaigns`, `reward_campaign_vaults`, and related rows while
retaining their Poll relationships.

### 8.2 Funding ownership

The shared funding boundary owns:

- server-derived principal, fee reserve, total, vault recipient, reference, and funding deadline;
- designated funding-wallet authorization;
- one active funding intent per settlement;
- bind idempotency and cross-ledger transaction-hash reuse protection;
- the `submitted` to `confirmed` funding transition only after observation and finality;
- exact underpayment rejection and explicit overpayment/excess accounting;
- no participant wallet funding path.

Current Poll funding routes remain Poll wrappers. They resolve the Poll-bound
settlement, verify the session against `reward_campaigns.funding_wallet`, and
call the existing funding RPCs. A future Campaign adapter would resolve a
separate Campaign-bound settlement and use the same shared funding context.

### 8.3 Payout ownership

The shared payout boundary owns:

- loading a receipt-authoritative recipient and exact amount;
- deriving the vault sender from the settlement vault;
- creating one attempt per receipt and bounded safe retries;
- acquiring a lease that serializes signing/broadcast per isolated vault;
- signing server-side with transient decrypted key material;
- persisting signed bytes and hash before network contact;
- persisting the broadcast-start marker before `sendTransaction`;
- treating hash-bearing uncertainty as non-retryable until reconciliation;
- observing the stored hash and requiring exact transfer and finality evidence;
- marking `paid` only in the guarded atomic confirmation transition.

`RewardPayoutStore`, `PayoutSigningContext`, `PayoutReconciliationContext`,
`runRewardPayout`, and `reconcilePayoutAttempt` are already close to this
boundary. Their source lookup must become settlement-based without moving source
eligibility into payout code.

### 8.4 Observation and finality

`createNimiqTransactionObservationAdapter` is the shared chain boundary. It
normalizes transaction data, then observes the canonical micro-block, batch,
and finalizing macro-block. `reconcileRewardFunding`,
`reconcileRewardPayout`, and `reconcileRewardRefund` are side-effect-free
policies over expected server facts and observed chain facts.

The shared service must retain the current distinction between:

- a client callback hash;
- a stored transaction hash;
- an observed transaction;
- canonical inclusion;
- successful execution;
- macro-block finality;
- an atomic database confirmation.

The current atomic RPCs accept server-produced evidence and validate it against
stored rows; they do not query the chain. That trusted-server boundary must
remain server-only and explicit. Generalization must not expose these RPCs to
the browser or allow an adapter to submit its own finality evidence.

## 9. Shared Closure / Refund Boundary

### 9.1 Responsibilities

`RewardClosureService` owns:

- determining whether the source participation window is closed;
- locking the settlement before checking obligations;
- classifying reserved, payout-pending, retryable, and manual-review obligations;
- requiring payout reconciliation before refund;
- validating paid principal and confirmed fee accounting;
- calculating the conservative refundable remainder;
- freezing new obligations before creating a refund intent;
- deriving refund recipient from immutable settlement owner identity;
- preparing, signing, broadcasting, observing, and confirming the refund;
- requiring finality before `refunded`;
- making closure, refund preparation, and final confirmation idempotent.

It does not decide whether a Poll vote, secret, event proof, or allowlist entry
was eligible. That decision belongs to the source adapter before reservation.

### 9.2 Source-neutral closure input

The existing `RewardClosureInput` is already close to a shared pure contract:

```ts
interface RewardClosureContext {
  settlement: RewardSettlementContext;
  source: {
    type: RewardParticipationSourceType;
    id: string;
    participationWindowClosed: boolean;
    closureTrigger: "source_closed" | "expired" | "cancelled";
  };
  receipts: ReadonlyArray<RewardClosureReceipt>;
  vaultBalanceLuna: bigint;
}
```

The Poll adapter maps Poll `closed`, an elapsed Poll end time, or the explicitly
allowed cancellation case into the source-neutral closure trigger. A future
Campaign adapter maps Campaign expiry or owner cancellation without pretending
that Campaign lifecycle is Poll lifecycle.

### 9.3 Closure algorithm

The shared closure path must:

1. Acquire the settlement lock before reading or mutating closure state.
2. Recheck the source lifecycle and permitted closure trigger.
3. Return a replay for an already closed or refunded settlement.
4. Block if any receipt remains `reserved`, `payout_pending`, or `retryable`.
5. Block if an attempt has a hash, broadcast marker, unknown outcome, or manual-review evidence that has not been reconciled.
6. Reconcile `paid_amount_luna` against paid receipts and `fee_spent_luna` against confirmed payout fees.
7. Validate the funding, principal, fee, excess, paid, and refundable equations using integer Luna.
8. Compute the ledger remainder and cap it at a conservative observed vault balance.
9. For a zero remainder, move to the terminal refunded state without fabricating a refund transaction.
10. For a positive remainder, create one frozen refund intent whose destination is the immutable owner/funder policy, then move to `refunding` atomically.
11. Block new receipts and payout attempts after the freeze.
12. Use the same vault lease and durable pre-broadcast markers as payout.
13. Confirm `refunded` only after exact observed refund transfer and macro finality.

### 9.4 Existing implementation mapping

`classifyRewardObligations` and `calculateRefundableRewardAmount` can be reused
as pure policy. `begin_reward_refund_atomic` currently remains Poll-bound because
it reads `reward_campaigns.poll_id`, `polls.status`, and `polls.ends_at`.
V2C.1 should extract the source lifecycle input around this function without
changing its Poll behavior. A future generic close RPC must not query a Poll as
an implicit universal source.

`runRewardRefund`, `RefundSigningContext`, and `RefundReconciliationContext`
already own source-independent refund execution. The future generalized store
must load the owner, vault, amount, and state from a financial settlement binding
rather than a Poll-shaped lookup.

## 10. Future Campaign Adapter Contract

No Campaign adapter is implemented in V2C.1. The contract it must satisfy is:

```ts
interface CampaignRewardParticipationRequest {
  participationCampaignId: string;
  verifiedSession: VerifiedWalletSession;
  evidence: unknown;
}

type CampaignRewardParticipationAdapter = RewardParticipationAdapter<
  CampaignRewardParticipationRequest
>;
```

The names above are conceptual and do not create `VerifiedWalletSession` or a
Campaign type in this slice.

### 10.1 Required Campaign adapter behavior

The future adapter must:

- load a separate `participation_campaigns` product entity by ID;
- derive immutable owner identity and the configured eligibility strategy from the server;
- canonicalize the verified session wallet;
- parse only the strategy-specific evidence expected for that Campaign;
- bind evidence to Campaign ID, wallet, purpose, and expiry;
- persist or consume a durable claim identity atomically where the strategy requires it;
- resolve the authoritative financial settlement binding from the server;
- derive reward amount, capacity, owner, vault, and settlement lifecycle from that binding;
- return a `RewardParticipationContext` with `source.type = 'campaign_claim'` and a durable claim/evidence ID;
- call the shared reservation boundary, never write a reward receipt directly;
- return generic safe errors for invalid or expired secrets and private eligibility checks;
- preserve one wallet per Campaign as a declared identity boundary, without claiming one human per wallet.

The browser may submit a Campaign ID and opaque evidence such as a secret code,
QR/deep-link value, or event proof. It may never submit authoritative
`eligible=true`, reward amount, recipient, cap, owner, vault, or settlement
status.

### 10.2 Eligibility strategy convergence

The first five future strategies converge at the same boundary:

| Future type | Adapter owns | Shared engine receives |
|---|---|---|
| Public Giveaway | Verified wallet and available capacity policy | Server-produced claim candidate and settlement identity |
| Secret Drop | Hash-only secret comparison, Campaign binding, expiry, rate limits, single-use policy | Durable valid claim evidence, not the plaintext secret |
| Private Drop | Canonical allowlist lookup, activation/version policy, privacy-safe response | Durable membership evidence, not a client membership assertion |
| Event Drop | Scoped event code/link/proof, expiry, replay, and device/deep-link policy | Durable event claim evidence, not a QR success boolean |
| Community Reward | Server-authoritative contributor/community set and version policy | Durable membership evidence, distinct from funding mode |

`funding_mode = 'community'` remains a funding-wallet choice. It must not be
reused as Community Reward eligibility.

### 10.3 Claim authentication

The existing wallet verification challenge can be reused for base wallet
control, but not unchanged as Campaign claim proof. A future Campaign claim
challenge or nonce must bind:

```text
purpose = campaign_claim
participation_campaign_id
canonical claimant wallet
random single-use nonce
expiry
```

Claim nonce consumption and Campaign-wallet uniqueness must be atomic. A session
proves wallet control; it does not prove that a secret, allowlist, event, or
community condition was satisfied.

## 11. Lifecycle Ownership

Lifecycle must be separated into source lifecycle, settlement lifecycle, and
attempt lifecycle. No layer should infer one from an unrelated layer's null
field.

| Concern | Owner | Rule |
|---|---|---|
| Poll status and vote window | Poll domain and `cast_poll_vote_atomic` | `draft`, `live`, `closed`, and `cancelled` remain Poll states. The Poll controls whether a new vote may be recorded. |
| Poll economic mode | Poll domain and Poll adapter | `legacy_support` and `reward_first` are explicit. `free` and `rewarded` are reward-first modes. A missing support field is not a mode discriminator. |
| Source participation | Source adapter | A Poll vote, Campaign claim, secret, allowlist, event proof, or community set has its own evidence and eligibility rules. |
| Reward offer terms | Settlement record | Per-participant amount, capacity, principal, fee reserve, total budget, asset, owner, and funding wallet are server-authoritative. |
| Funding lifecycle | Settlement engine | `submitted`, `confirmed`, and `rejected` funding states. Only observed and final funding can produce `funded`. |
| Reward reservation lifecycle | Reservation engine | `reserved`, counter increment, `first_reservation_at`, and `rewarding`/`exhausted` transition are atomic. |
| Payout attempt lifecycle | Settlement engine | `pending`, `confirmed`, `failed`, and `retryable` describe an attempt, not a source. A hash-bearing unknown outcome remains reconciliation work. |
| Receipt lifecycle | Reservation and settlement engine | A receipt becomes `paid` only after exact final payout evidence. Pending or retryable receipts remain obligations. |
| Source close trigger | Source adapter | Poll maps `closed`/elapsed end to a source-neutral close trigger. Campaigns later map their own expiry or cancellation. |
| Closure and refund lifecycle | Closure engine | `closed`, `refunding`, and `refunded` are financial terminal transitions with unresolved-obligation and finality guards. |
| Vault serialization | Settlement engine | One isolated vault lease serializes signing and external network calls for the settlement. |
| Browser/UI state | Product surface | Read-only projection. It never decides lifecycle or financial truth. |

### 11.1 State mapping

The current reward state vocabulary remains the baseline:

```text
configured -> funding_pending -> funded -> rewarding -> exhausted
                                      \-> closed -> refunding -> refunded
configured/funded -> cancelled (policy-dependent)
```

`Poll.status` must remain separate from reward settlement state. A Poll can be
closed while already-created reward obligations are still being paid or
reconciled. A future Campaign may expire without creating a Poll-like status.

### 11.2 Freeze boundaries

The following boundaries are mandatory:

- Reward terms are mutable only while the settlement is `configured`.
- Funding intent creation moves the settlement to `funding_pending`; funding intent snapshots are immutable.
- The first successful reservation sets `first_reservation_at` atomically and freezes the terms against participant-impacting changes.
- Campaign closure/refund preparation freezes new receipts and payout attempts.
- A confirmed payout, confirmed refund, and terminal settlement proof are immutable except for safe replay reads.
- A source adapter cannot reopen a closed Poll or settlement by producing a new context.

The current application configuration route enforces the configured-only edit
rule, reservation sets `first_reservation_at`, and refund triggers enforce the
stronger closed/refunding/refunded freeze. The generalized implementation must
make the first-reservation freeze explicit in the shared contract and preserve
the existing database guards. It must not claim that a context snapshot itself
is a freeze mechanism.

## 12. Database Implications

### 12.1 V2C.1 database decision

No database change is required for V2C.1. The first implementation can introduce
shared interfaces in application/domain code while the existing Poll-backed
tables remain authoritative.

This is the least risky path because it:

- leaves `reward_campaigns.poll_id NOT NULL UNIQUE` intact;
- leaves historical `legacy_support` tables and rows untouched;
- keeps Poll reward receipts auditable through their existing `poll_id`;
- permits the Poll adapter to call the already-tested atomic RPCs;
- avoids speculative Campaign tables before the Campaign product contract exists;
- keeps the existing service-role-only RLS and grant model unchanged.

V2C.1 must not add:

- `participation_campaigns`;
- a generic nullable source column to `reward_campaigns`;
- a nullable `poll_id` or polymorphic foreign key;
- a second reward ledger;
- Campaign claim, secret, allowlist, event, or community tables;
- a migration or generated database type update.

### 12.2 Current database authority

For V2C.1, the Poll adapter should project existing rows as follows:

| Shared concept | Current Poll-backed source |
|---|---|
| Settlement ID | `reward_campaigns.id` |
| Source ID | `poll_votes.id` |
| Source-to-settlement binding | `reward_campaigns.poll_id = polls.id = poll_votes.poll_id` |
| Owner | `polls.creator_wallet`, cross-checked with `reward_campaigns.creator_wallet` |
| Participant | `poll_votes.voter_wallet`, cross-checked with verified session wallet |
| Reward amount | `reward_campaigns.reward_per_participant_luna` |
| Capacity | `reward_campaigns.max_rewarded_participants` and `rewarded_participant_count` |
| Vault identity | `reward_campaign_vaults.vault_address_hex` |
| First reservation | `reward_campaigns.first_reservation_at` |
| Funding and balance | `reward_campaigns` plus `reward_funding_transactions` |
| Receipt | `reward_receipts` |
| Payout attempt | `reward_payout_attempts` through receipt |
| Refund | `reward_refunds` |

### 12.3 Known schema limitations to resolve later

- `reward_receipts` has raw text uniqueness for `(campaign_id, participant_wallet)`. Current routes and RPC comparisons canonicalize wallet values, but arbitrary direct service-role writes are not fully protected by a canonical database invariant.
- `reward_payout_attempts` reaches the settlement through `reward_receipts` and has no direct generic settlement ID.
- `reward_refunds` stores the immutable creator destination but currently reaches source lifecycle through the Poll-bound settlement and Poll status.
- `reward_funding_transactions` retains historical `creator_wallet` alongside the designated `funder_wallet`; future naming must preserve the audit trail rather than reinterpret old rows.
- `reward_campaign_vaults` uses `campaign_id` as its primary key and the current vault service is named around campaigns.
- The current public reward function is `get_public_reward_campaign(_poll_id)` and is intentionally Poll-ID based.

These are design inputs for the later additive financial binding. They are not
reasons to alter the schema in V2C.1.

### 12.4 Expected later schema direction

V2C.2+ should first define a separate `participation_campaigns` product entity
with type, owner, source metadata, eligibility strategy, configured lifecycle,
and expiry. A separate financial binding should then associate that product
entity with a source-independent reward settlement.

The exact later shape may be a new generic settlement table plus explicit
bindings, or a carefully additive extension of the financial records. It must
keep existing Poll rows valid without making `poll_id` nullable. It must also
add database-enforced canonical wallet uniqueness, durable Campaign claim
identity, versioned eligibility evidence where needed, and source-neutral refund
proof. That decision is deliberately deferred until the Campaign product
entity and closure management are designed.

## 13. API / Service Implications

### 13.1 V2C.1 API rule

There are no new public API routes and no public request-shape changes in V2C.1.
The current `/api/polls/...` routes remain the compatibility shell.

The internal service boundary should be introduced behind those routes:

```text
/api/polls/[pollId]/vote
  -> Poll vote RPC
  -> PollRewardParticipationAdapter
  -> RewardReservationService
  -> RewardSettlementService
```

The funding, payout reconciliation, and refund routes remain Poll-scoped
wrappers while the internal services become source-independent. Future Campaign
routes must be separate Campaign-ID routes and are deferred.

### 13.2 Existing route preservation

The following behavior must remain unchanged during extraction:

- `POST /api/polls/[pollId]/vote` authenticates the session, accepts `optionId`, records the vote, and returns the current response shape.
- A successful vote remains valid even when reward reservation or automatic payout fails.
- Rewarded Poll payout remains automatic; no Poll Claim endpoint or button is added.
- Poll reward funding intent, bind, and confirm endpoints remain under the Poll route namespace.
- Poll refund remains creator-authorized and Poll-scoped until a future Campaign management surface exists.
- Public Poll mapping remains a discriminated union with legacy support fields unavailable on reward-first views.
- Public reward status remains allowlisted and never returns vault ciphertext, key material, session data, or selected-option data.

### 13.3 Internal service interfaces

The proposed interfaces are server-only and intentionally narrow:

```ts
interface RewardReservationService {
  reserve(
    context: RewardParticipationContext,
  ): Promise<RewardReservationResult>;
}

interface RewardSettlementService {
  executePayout(
    settlementId: string,
    receiptId: string,
  ): Promise<RewardPayoutResult>;
  reconcilePayout(
    settlementId: string,
    attemptId: string,
  ): Promise<PayoutReconciliationExecutionResult>;
}

interface RewardClosureService {
  prepareRefund(
    context: RewardClosureContext,
  ): Promise<RewardClosureResult>;
  executeRefund(
    settlementId: string,
    refundId: string,
  ): Promise<RewardRefundResult>;
}
```

These methods are conceptual. The actual implementation may retain the current
store/dependency injection shapes. The critical rule is that none accepts a
browser-deserialized `RewardParticipationContext` or client economics.

### 13.4 Browser authority boundary

For Polls, the browser sends only the Poll route's option selection. The server
gets the wallet from `getVerifiedWalletSession`, gets the source vote from
`cast_poll_vote_atomic`, and resolves the financial context from the database.

For future Campaigns, the browser may send a Campaign ID and opaque strategy
evidence. The server resolves and consumes it. No browser request may set
`eligible`, `rewardAmountLuna`, `participantWallet`, `maxParticipants`,
`ownerWallet`, `vaultAddressHex`, or settlement state.

## 14. Security Model

Generalization is acceptable only if every current guarantee is retained at the
same or a stronger boundary.

| Guarantee | Current protection | Required shared behavior |
|---|---|---|
| Wallet-session authority | Same-origin challenge, signed wallet proof, hashed cookie, expiry, revocation, server session lookup | Reuse for authentication. Adapters compare the source wallet with the verified session wallet. |
| Campaign claim authority | Not present in current Poll flow | Future Campaign adapter must add Campaign-bound claim purpose, nonce, expiry, and atomic consumption. A base session is insufficient. |
| Server-derived economics | Funding and reservation RPCs load terms from reward tables | Context values are snapshots only; reservation and settlement reload authoritative terms under lock. |
| Private vault secrecy | Separate RLS-protected vault table, AES-256-GCM envelope, transient key scope, address self-check | Keep vault custody inside settlement execution. No adapter or browser receives key material. |
| Hash uniqueness | Partial unique indexes, advisory hash locks, cross-ledger trigger/RPC checks, canonical lower/trim normalization in current hardened paths | Every future financial writer uses the same cross-ledger lock and canonical hash policy. |
| Same-vault serialization | Durable campaign lease held across signing and external broadcast | Lease on the source-independent settlement/vault identity. It must cover payout and refund calls. |
| Duplicate-send protection | Signed bytes and hash persist before broadcast; `broadcast_started_at` is persisted before the call | Unknown or hash-bearing outcomes require observation; no automatic blind resend. |
| Finality before paid/refunded | Server observation checks exact transfer, canonical micro-block, batch, macro finality, then guarded RPC transition | Keep chain observation and evidence server-only. Financial status changes only after finality policy passes. |
| Refund freeze | Campaign lock, closed/refunding/refunded triggers, blocked receipt/payout writes, immutable refund economics | Closure service freezes the settlement before a positive refund intent and blocks new obligations. |
| Idempotency | One campaign per Poll, one receipt per wallet, one attempt number, one refund, replay-safe RPC results | Source identity and settlement identity remain separate; replay is evaluated before capacity where required. |
| Concurrency | Poll vote advisory lock, campaign row lock, receipt unique constraint, hash advisory lock, vault lease | Adapter resolution may be concurrent, but reservation and terminal mutation remain atomic under the settlement lock. |
| Option privacy | Reward tables, payout/refund rows, public reward reads, and reward profile shapes omit `option_id` | Shared contexts must not carry selected option. Poll-specific option data ends at the Poll vote boundary. |
| Integer money | Bigint database fields, strict decimal parser, bigint arithmetic, safe conversion at Nimiq Pay boundary | All shared amounts remain integer Luna; no floating-point economics or client arithmetic. |
| Owner/refund identity | Campaign creator is checked against Poll creator; refund destination is derived from immutable creator identity | Future owner and refund policy are settlement authority, never request-body destinations. |

### 14.1 Trust boundary warning

The current finality RPCs accept server-produced evidence and compare it with
stored financial terms; they do not independently query the chain. That is safe
only while the observation adapter and all callers remain server-only and the
evidence shape is strictly validated. V2C.1 must preserve that trust boundary
and should consider a stronger database/evidence consistency backstop before a
generic Campaign settlement RPC is exposed.

### 14.2 Canonical identity warning

The shared contract should use the repository's canonical address path
(`normalizeAddress` / `canonicalWalletKey`) for comparisons. It must not claim
that a wallet is a human identity. One canonical wallet per settlement is the
declared anti-duplicate boundary; Sybil resistance is not being generalized in
V2C.1.

## 15. Poll Compatibility Guarantees

The following are non-negotiable acceptance guarantees after implementation:

1. Free reward-first Polls create no reward campaign, receipt, funding obligation, payout attempt, refund, or participant support contribution.
2. `legacy_support` remains historical and distinct. Existing support routes, rows, totals, receipts, and Poll behavior are not reinterpreted as reward-first.
3. `reward_first` remains distinct from legacy support, with `free` and `rewarded` modes preserved.
4. A valid rewarded Poll vote may create at most one reward receipt for the canonical wallet and settlement.
5. A reward reservation or payout failure does not invalidate a valid Poll vote or change the current vote response semantics.
6. The Poll creator may vote with normal Poll voting power but never receives a reward for that Poll.
7. Selected option data never determines reward amount, capacity, eligibility amount, receipt, payout, refund, profile metric, or public reward proof.
8. Funding remains designated-wallet authorized, exact-term based, hash-idempotent, and pending until server-observed finality.
9. Payout remains exact-transfer based, server-signed, per-vault serialized, retry-bounded, and finality-gated before `paid`.
10. Refund remains creator-authorized, unresolved-obligation gated, accounting-checked, freeze-protected, idempotent, and finality-gated before `refunded`.
11. Poll UI and public Poll/API behavior remain compatible. No Poll Claim flow or visible settlement rewrite is introduced.
12. Reward configuration and public reward reads continue to reject legacy/free Poll misuse and keep private vault data out of responses.

The V2B.2.13 regression gate is the baseline for these guarantees. The latest
verified gate reported 50 test files and 524 passing tests, plus passing
TypeScript, ESLint, production build, and local integration suites. Future
implementation must rerun that baseline rather than replacing it with only new
adapter tests.

## 16. Migration / Rollout Strategy

V2C.1 is an additive application/domain extraction with no database migration.

### Phase 1: Contract-only introduction

- Add server-only types and result unions.
- Add pure invariant tests for context construction and rejection.
- Do not change a route or database function.
- Do not expose the context to the browser.

### Phase 2: Poll adapter behind existing vote flow

- Resolve a context from the existing successful `poll_votes.id`.
- Keep `claim_reward_receipt_atomic` as the final Poll reservation authority.
- Keep automatic payout after a valid vote.
- Compare adapter output with database-loaded values and fail closed on mismatch.
- Verify that free, legacy, creator, private, exhausted, duplicate, and failed-reservation cases preserve current behavior.

### Phase 3: Settlement context extraction

- Introduce source-independent funding, payout, and reconciliation loaders around existing stores and RPCs.
- Keep Poll route wrappers and current Poll IDs at the HTTP boundary.
- Keep Nimiq observation, vault signing, hash safeguards, lease behavior, and finality evidence unchanged.
- Do not create a generic Campaign database binding yet.

### Phase 4: Closure context extraction

- Feed Poll close/expiry/cancellation decisions into a source-independent closure policy.
- Reuse the existing pure refund policy and execution boundaries.
- Keep the current Poll-bound closure RPC as the compatibility implementation until a later generic binding is safe.
- Verify that freeze and unresolved-obligation behavior is identical.

### Phase 5: Compatibility gate

- Run all existing V2B.2.13 tests and local integration suites.
- Run pure adapter, concurrency, authority, and failure-injection tests.
- Run `npx tsc --noEmit`, `npm run lint`, and `npm run build`.
- Do not claim Campaign readiness from this gate.
- Physical Nimiq Pay QA remains a separate later checkpoint.

Rollback is a route-level revert to the pre-extraction Poll service call because
there is no V2C.1 schema change or data backfill. No Poll rows need migration.

## 17. Testing Strategy

### 17.1 Contract tests

Add pure tests for:

- required source type and source ID;
- canonical participant and owner identity;
- evidence ID and server verification time;
- exact integer Luna reward amount;
- settlement ID distinct from source ID;
- capacity snapshot and non-negative count;
- vault address shape and settlement state;
- source-open versus source-closed lifecycle;
- rejection of client-shaped context or selected-option fields;
- stale context mismatch against a reloaded settlement snapshot.

### 17.2 Poll adapter tests

Use the existing V2B.2 local fixtures and add assertions for:

- rewarded reward-first Poll resolves `poll_vote` context from a durable vote;
- free Poll resolves no reward context and creates no reward row;
- legacy Poll remains outside the reward adapter;
- creator vote is accepted but returns creator-ineligible for reward;
- private Poll and non-public lifecycle fail closed;
- Poll/campaign owner mismatch fails closed;
- vote/campaign Poll ID mismatch fails closed;
- missing vault or malformed campaign terms fail closed;
- the selected option is not present in the context;
- changing selected option changes no reward amount;
- a valid vote remains committed when reservation or payout fails;
- duplicate vote replay does not create a second receipt;
- exhausted capacity returns the current no-capacity behavior without invalidating the vote.

### 17.3 Reservation and concurrency tests

Preserve and extend the existing DB tests for:

- one-wallet-one-vote;
- one-wallet-one-receipt;
- final-slot race;
- replay before capacity check;
- `first_reservation_at` set exactly once;
- amount loaded from the settlement, not context or option;
- legacy/free guard;
- campaign owner exclusion;
- no receipt on failed or ineligible source evidence;
- no post-freeze receipt or payout insert.

### 17.4 Settlement tests

Keep the current unit and local DB suites for:

- exact funding terms and designated funder authorization;
- funding hash idempotency and cross-ledger reuse;
- funding observation and underpayment/overpayment behavior;
- vault key secrecy, envelope integrity, and derived-address self-check;
- signed bytes/hash persisted before broadcast;
- broadcast-start marker before network contact;
- hash-bearing unknown outcome never auto-resends;
- only definite hashless pre-broadcast failure is retryable;
- same-vault lease and release behavior;
- exact payout sender, recipient, amount, network, and finality evidence;
- `paid` only after final confirmation;
- refund preparation, fee accounting, closure freeze, exact remainder, and final refund proof.

### 17.5 Full gate

The implementation must rerun the established sequence against local-only
services when available:

```text
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism
npm run lint
npx tsc --noEmit
npm run build
npx tsx src/lib/api/v2b2-schema-test.ts
npx tsx src/lib/api/v2b2-config-test.ts
npx tsx src/lib/api/v2b2-funding-test.ts
npx tsx src/lib/api/v2b1-backward-test.ts
npx tsx src/lib/api/publish-test.ts
```

No hosted Supabase target may substitute for a local-only integration suite.
No physical wallet approval, chain transfer, or NIM send belongs in this design
or the V2C.1 automated gate.

## 18. Risks

### Risk 1: Poll assumptions leak below the adapter

The current financial records and RPCs contain `poll_id`, Poll status checks,
and Poll creator assumptions. A superficial rename would falsely claim
generalization. Mitigation: keep source lookup above the shared boundary and
make every Poll-specific query visible in the Poll adapter or compatibility
store.

### Risk 2: Context becomes a new trust boundary

A typed object can still be forged if it crosses an HTTP boundary. Mitigation:
keep context types server-only, construct them from durable rows, and reload and
compare all economic fields under the reservation or settlement lock.

### Risk 3: Historical legacy reward rows

Some historical rows may retain reward campaign data even when their Poll is
classified as `legacy_support`. The latest SQL hardening intentionally rejects
legacy Poll reservation. Mitigation: preserve the explicit discriminator and do
not reuse the old `eligibility.ts` branch that equates a non-null campaign with
reward eligibility.

### Risk 4: Canonical wallet uniqueness is incomplete in the current schema

Current API and RPC paths canonicalize or compare wallets, but raw text
uniqueness remains. Mitigation: preserve current route behavior in V2C.1 and
make canonical storage/uniqueness a prerequisite before standalone Campaign
claims.

### Risk 5: Financial binding cannot yet represent a standalone Campaign

The current tables are Poll-bound. Mitigation: do not make `poll_id` nullable;
defer the additive financial binding until V2C.2 product and schema design.

### Risk 6: Finality evidence trust

The finality RPC validates server-produced evidence rather than querying the
chain itself. Mitigation: preserve the observation adapter as the only server
observer, keep RPCs service-role only, and strengthen the evidence boundary
before generic exposure.

### Risk 7: Closure semantics diverge

Poll close, Campaign expiry, and creator cancellation are different source
events. Mitigation: adapters map source lifecycle to a shared closure input;
the closure engine never reads Poll status as a universal rule.

### Risk 8: Poll automatic payout is accidentally changed to a claim flow

Campaigns will likely need intentional claims, while Polls use automatic payout.
Mitigation: source type and adapter policy remain explicit; Poll route continues
the post-vote payout path and never gains a Claim button.

### Risk 9: Vault lease scale

The current lease serializes external calls per campaign but is not a durable
queue. Mitigation: reuse it for V2C.1 and defer durable queue/recovery tooling
until Campaign management and throughput require it.

### Risk 10: Funding excess and unsolicited inflows

Current confirmed funding records one transaction's excess, while additional
or unsolicited vault inflows remain a later accounting concern. Mitigation: do
not advertise a generic Campaign as production-ready until the closure policy
defines all vault inflows and refund limits.

## 19. Deferred Work

The following remains outside V2C.1:

- `participation_campaigns` product entity and Campaign creation flow;
- generic financial settlement binding for a standalone Campaign;
- Campaign claim route and Campaign-bound wallet challenge/nonce;
- Public Giveaway implementation;
- Secret Drop hashing, rate limiting, generic errors, and replay policy;
- Private Drop allowlist storage, import, versioning, and privacy model;
- Event Drop proof, QR/deep-link contract, replay, and device validation;
- Community Reward contributor-set model and funding/eligibility separation;
- Campaign creator management, close, retry/manual-review, and public proof routes;
- Campaign discovery and type-aware Campaign UI;
- database-enforced canonical Campaign-wallet uniqueness;
- generic refund evidence and any Campaign-specific owner/refund policy;
- durable payout/reconciliation queue and operator tooling;
- finality evidence hardening or independent chain-proof backstop;
- profile `nimEarnedLuna` integration and Campaign activity surfaces;
- physical Nimiq Pay QA and production HTTPS session-restore verification;
- any smart contract, multisig, cashlink, token, NFT, recurring, team, leaderboard, or Sybil product.

V2C.2 must not begin a funded Campaign MVP until closure/refund, creator
management, claim replay protection, and public proof boundaries are complete.

## 20. Exact V2C.1 Implementation Slices

The following sequence is intentionally conservative and keeps each slice
independently testable.

### V2C.1A - Shared types/contracts + Poll adapter tests

**Scope:** Add the server-only `RewardParticipationContext`, adapter result
types, reservation/settlement/closure contract types, and pure invariant tests.

**Poll work:** Specify and test `PollRewardParticipationAdapter` resolution from
`poll_votes.id`, including legacy/free/creator/private/malformed guards. Do not
change Poll runtime behavior yet.

**Pass criteria:** Context cannot be built from a browser payload; amount,
capacity, owner, vault, source, and lifecycle meanings are explicit; adapter
tests prove selected option is excluded.

### V2C.1B - Reservation boundary extraction

**Scope:** Place the Poll adapter and `RewardReservationService` around the
existing `claim_reward_receipt_atomic` behavior. Keep the current Poll RPC as
the final atomic authority and keep `poll_id` required.

**Required hardening:** Align or isolate `src/lib/rewards/eligibility.ts` so a
legacy Poll with a historical reward row cannot enter the shared reward path.
Reload and compare database authority rather than trusting the context.

**Pass criteria:** Existing reservation DB tests, final-slot races, replay
semantics, creator exclusion, free/legacy guards, and valid-vote-on-reservation-
failure behavior all pass unchanged.

### V2C.1C - Settlement context generalization

**Scope:** Extract source-independent loaders and orchestration seams around
funding, vault signing, payout, broadcast, reconciliation, finality, and retry.
Keep `RewardPayoutStore`, current funding RPCs, current observation adapter, and
Poll route wrappers compatible while replacing implicit Poll assumptions in
shared service code with settlement identity.

**Pass criteria:** Funding, hash, vault, payout, broadcast, lease, and finality
tests pass; no client economics enter a shared service; every signed transfer
still persists before network contact.

### V2C.1D - Closure/refund context generalization

**Scope:** Extract source-neutral closure input from the existing Poll-bound
`begin_reward_refund_atomic` path. Reuse `RewardClosureContext`, obligation
classification, accounting, refund preparation, signing, broadcast, and finality
policies. Keep Poll closure mapping explicit and preserve Poll refund routes.

**Pass criteria:** Unresolved obligations, payout reconciliation, fee accounting,
zero remainder, positive remainder, refund freeze, same-vault lease, retry, and
finality tests remain green.

### V2C.1E - Poll compatibility and full regression gate

**Scope:** Run the complete V2B.2.13 baseline plus all new adapter/contract tests.
Review every route and serializer that can read reward or support fields. Confirm
that no Poll UI or API behavior changed and that no Campaign implementation
slipped into the branch.

**Pass criteria:** Free Polls have no reward obligations; legacy support remains
distinct; rewarded Polls retain automatic payout; creator votes remain allowed
but unpaid; selected option remains outside reward records; funding/payout/refund
safety remains identical; typecheck, lint, build, and local-only tests pass.

### Slice ordering rule

Do not begin V2C.2 Campaign entity work until V2C.1E passes. Do not use a
Campaign fixture, Campaign table, or Campaign route to prove V2C.1. The Poll
adapter is the only runtime source implemented by this sequence.

## Evidence Index

### V2B.2 financial implementation

- `supabase/migrations/20260822000000_v2b2_rewarded_participation.sql`
- `supabase/migrations/20260822120000_v2b2_reward_campaign_vaults.sql`
- `supabase/migrations/20260822130000_v2b2_campaign_funding_initiation.sql`
- `supabase/migrations/20260822130100_v2b2_funding_hash_guard.sql`
- `supabase/migrations/20260906000000_v2b2_confirm_reward_funding.sql`
- `supabase/migrations/20260906010000_v2b2_reserve_participant_reward.sql`
- `supabase/migrations/20260912010000_v2b2_broadcast_reserved_reward_payouts.sql`
- `supabase/migrations/20260912020000_v2b2_reconcile_reward_payouts.sql`
- `supabase/migrations/20260912030000_v2b2_safe_reward_payout_retry.sql`
- `supabase/migrations/20260912040000_v2b2_prepare_reward_refund.sql`
- `supabase/migrations/20260912050000_v2b2_broadcast_prepared_reward_refunds.sql`
- `supabase/migrations/20260912060000_v2b2_reconcile_reward_refunds.sql`
- `supabase/migrations/20260912070000_v2b2_regression_gate_hardening.sql`

### V2B.2 service and route implementation

- `src/lib/rewards/domain.ts`
- `src/lib/rewards/config.ts`
- `src/lib/rewards/eligibility.ts`
- `src/lib/rewards/states.ts`
- `src/lib/rewards/funding.ts`
- `src/lib/rewards/funding-confirmation.ts`
- `src/lib/rewards/reconciliation.ts`
- `src/lib/rewards/payout.ts`
- `src/lib/rewards/payout-reconciliation.ts`
- `src/lib/rewards/refund.ts`
- `src/lib/rewards/refund-policy.ts`
- `src/lib/rewards/refund-reconciliation.ts`
- `src/lib/rewards/vault-key.ts`
- `src/lib/rewards/vault-service.ts`
- `src/lib/rewards/vault-signing.ts`
- `src/lib/nimiq/observation.ts`
- `src/lib/api/session.ts`
- `src/app/api/polls/[pollId]/vote/route.ts`
- `src/app/api/polls/[pollId]/reward/config/route.ts`
- `src/app/api/polls/[pollId]/reward/funding/intents/route.ts`
- `src/app/api/polls/[pollId]/reward/funding/intents/[intentId]/bind/route.ts`
- `src/app/api/polls/[pollId]/reward/funding/intents/[intentId]/confirm/route.ts`
- `src/app/api/polls/[pollId]/reward/payouts/[attemptId]/reconcile/route.ts`
- `src/app/api/polls/[pollId]/reward/refund/route.ts`

### Poll and wallet schema

- `supabase/migrations/0001_votum_poll_foundation.sql`
- `supabase/migrations/0002_wallet_proof_sessions.sql`
- `supabase/migrations/20260731081012_poll_votes_foundation.sql`
- `supabase/migrations/20260831160000_v2b2_reward_first_alignment.sql`
- `src/types/poll.ts`
- `src/types/rewards.ts`
- `src/lib/data/public-polls.ts`

### Regression and design records

- `src/lib/api/v2b2-schema-test.ts`
- `src/lib/api/v2b2-config-test.ts`
- `src/lib/api/v2b2-funding-test.ts`
- `src/lib/api/v2b2-vault-test.ts`
- `src/lib/api/publish-test.ts`
- `src/lib/rewards/eligibility.test.ts`
- `src/lib/rewards/payout.test.ts`
- `src/lib/rewards/payout-reconciliation.test.ts`
- `src/lib/rewards/refund-policy.test.ts`
- `src/lib/rewards/refund-reconciliation.test.ts`
- `docs/superpowers/reviews/2026-09-12-v2c0-campaign-integration-readiness-audit.md`
- `docs/superpowers/specs/2026-08-22-v2b2-rewarded-participation-design.md`
- `docs/superpowers/specs/2026-08-31-v2b2-reward-first-product-alignment-design.md`
- `docs/superpowers/plans/2026-08-31-v2b2-reward-first-product-alignment-implementation.md`
