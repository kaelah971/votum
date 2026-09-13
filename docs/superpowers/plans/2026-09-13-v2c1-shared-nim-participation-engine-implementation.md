# V2C.1 Shared NIM Participation Engine Implementation Plan

**Status:** TDD implementation plan only. This document does not implement the
shared engine, add Campaign entities, add schema, add migrations, add routes,
change Poll UI, start Docker, mutate Supabase, send NIM, deploy, or merge
`main`.

**Design authority:**
`docs/superpowers/specs/2026-09-12-v2c1-shared-nim-participation-engine-design.md`

**Branch:** `feat/v2-participation-record`

**Execution rule:** For each slice, write the failing unit, route, or local DB
assertion first (RED), implement the smallest change that makes it pass (GREEN),
then refactor without changing the tested contract. Each slice is independently
testable and receives its own implementation commit. The final documentation
commit is separate from those implementation commits.

## 1. Guardrails and Baseline

### 1.1 Non-negotiable scope

- Keep `reward_campaigns.poll_id NOT NULL UNIQUE` unchanged.
- Do not create `participation_campaigns` or any Campaign product type.
- Do not add a nullable source column, polymorphic foreign key, second ledger, or
  Campaign claim storage.
- Do not add public API routes or change public request shapes.
- Keep `/api/polls/[pollId]/vote` as the Poll voting boundary and preserve its
  current response behavior.
- Keep rewarded Poll payout automatic. Do not add a Poll Claim route, button, or
  claim UX.
- Keep `poll_votes`, `poll_options`, Poll status, Poll economic model, and Poll
  vote uniqueness Poll-specific.
- Do not put `option_id`, selected-option data, reward amount, capacity, vault,
  settlement state, or `first_reservation_at` in `RewardParticipationContext`.
- Do not accept client-supplied participant wallet, owner wallet, reward amount,
  capacity, vault, eligibility boolean, settlement state, or financial snapshot.
- Treat TypeScript interfaces as internal handoff documentation, never as the
  financial security authority.
- Preserve the current service-role-only RPC grants and database authority.
- Reuse the current Nimiq observation adapter, vault custody boundary, signing,
  broadcast markers, lease behavior, finality proof, and retry rules.
- Do not add a database migration or modify `src/types/database.ts`.
- Do not run hosted Supabase commands, physical wallet approval, chain transfer,
  Nimiq Pay, or production deployment.

### 1.2 Protected worktree files

Do not modify or stage these existing worktree files:

- `next.config.ts`
- `.env.local`
- `dev-server-t12.log`
- `dev-server-t12.err.log`
- `scripts/seed-device-qa-fixtures.ts`

### 1.3 Verified current implementation map

The current route and financial boundaries are:

```text
POST /api/polls/[pollId]/vote
  -> getVerifiedWalletSession()
  -> cast_poll_vote_atomic
  -> reward_campaigns lookup by poll_id
  -> claim_reward_receipt_atomic(vote_id, campaign_id)
  -> executeReservedRewardPayout(receipt_id, campaign_id)
```

The current Poll reservation RPC is the final atomic authority. It reloads and
locks the Poll-bound `reward_campaigns` row, reloads `poll_votes` and `polls`,
checks public/rewarded Poll state, excludes the creator, checks capacity, inserts
the receipt, increments the counter, sets `first_reservation_at`, and returns a
replay-safe result.

The current financial modules are already split by irreversible boundary:

- `src/lib/rewards/funding-confirmation.ts` observes and confirms funding.
- `src/lib/rewards/payout.ts` prepares, signs, marks broadcast start, broadcasts,
  and handles safe retry/unknown outcomes.
- `src/lib/rewards/payout-reconciliation.ts` observes and confirms payout finality.
- `src/lib/rewards/refund.ts` prepares, signs, marks broadcast start, broadcasts,
  and handles safe retry/unknown outcomes.
- `src/lib/rewards/refund-reconciliation.ts` observes and confirms refund finality.
- `src/lib/rewards/refund-policy.ts` performs pure obligation/accounting policy.
- `src/lib/nimiq/observation.ts` is the sole chain-observation boundary.
- `src/lib/rewards/vault-service.ts` and `src/lib/rewards/vault-signing.ts` own
  server-side vault custody and signing.

There is currently no standalone reservation service, settlement service, or
closure service. The plan adds those seams without replacing the existing SQL
authority in this version.

### 1.4 Current closure naming collision

The design reserves `RewardClosureTrigger` for a source-neutral object, but the
current `src/lib/rewards/refund-policy.ts` exports `RewardClosureTrigger` as the
Poll/financial string union `"poll_closed" | "expired" | "cancelled"`.

Do not silently reuse that string union for the new handoff. In V2C.1D, rename
the current policy-only union to `RewardPolicyClosureTrigger` and keep its
existing values and behavior. Define the source-neutral object named
`RewardClosureTrigger` in the new server-only contracts module. The Poll adapter
maps its source lifecycle decision to the new object; the Poll compatibility
closure store maps it to the existing SQL policy without changing the SQL RPC.

### 1.5 Baseline and local-only command policy

Before implementation slices, record the existing baseline when local services
are available:

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

`package.json` defines `npm test`, `npm run lint`, and `npm run build`; there is
no TypeScript script, so typechecking uses `npx tsc --noEmit`. Database suites
must continue to call `assertLocalSupabaseForTests()` and may use Docker only
for the local `supabase_db_votum` target. If local services are unavailable,
report those suites as skipped rather than substituting a hosted database.

The latest recorded V2B.2.13 gate is the compatibility baseline, not a reason
to omit rerunning it after implementation. The documentation-only plan change
itself does not require a production build or database test.

## 2. Contract Ledger

The following internal contracts are the handoff between source-specific Poll
participation and the shared financial engine. They are server-only and are not
serialized into browser responses.

### 2.1 Participation context

Add these types to `src/lib/rewards/participation.ts`:

```ts
import "server-only";

export type RewardParticipationSourceType = "poll_vote" | "campaign_claim";

export interface RewardParticipationContext {
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
    binding: {
      sourceType: RewardParticipationSourceType;
      sourceId: string;
    };
  };
}

export interface RewardParticipationAdapter<TRequest> {
  resolveParticipation(
    request: TRequest,
  ): Promise<
    | { kind: "eligible"; context: RewardParticipationContext }
    | { kind: "ineligible"; reasonCode: string; sourceId?: string }
  >;
}
```

The implementation may add a small internal constructor/shape validator, but
must not add branded or opaque types as simulated security. Tests must prove
that the constructor accepts only server-derived fields and rejects objects
containing `optionId`, `selectedOptionId`, reward amounts, capacity, vault
address, settlement state, or `firstReservationAt`.

### 2.2 Financial contracts

The same module may define the service-only financial context and result shapes:

```ts
export interface RewardSettlementContext {
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

export interface RewardClosureTrigger {
  source: {
    type: RewardParticipationSourceType;
    id: string;
  };
  settlement: {
    id: string;
    binding: {
      sourceType: RewardParticipationSourceType;
      sourceId: string;
    };
  };
  reason: "source_closed" | "elapsed" | "expired" | "creator_cancelled" | "source_specific";
  observedAt: string;
}

export interface RewardClosureContext {
  trigger: RewardClosureTrigger;
}
```

`RewardSettlementContext` is a service-loaded snapshot, never an adapter output
or request body. It may contain financial values only after the settlement
service has reloaded the authoritative rows. `RewardClosureContext` contains
only the trigger. It never contains a session token hash, amount, vault,
balance, obligation list, or lifecycle snapshot.

Define result contracts with no private financial snapshot leakage:

- `RewardReservationResult`: `reserved` or `replay` carries the settlement ID,
  receipt ID, and receipt status; `ineligible` and `rejected` carry only a safe
  reason code and optional source ID.
- `RewardSettlementService`: exposes settlement-ID methods for funding intent,
  funding confirmation, payout execution, and payout reconciliation; it may
  retain the existing dependency-injection shapes internally.
- `RewardClosureService`: exposes `prepareRefund(context, authorization)` and
  `executeRefund(settlementId, refundId)`; authorization is a separate
  server-only capability, not part of the closure context.

The compatibility implementation may continue using the physical database name
`campaignId` inside existing payout/refund snapshots and RPC argument names.
At the new service boundary, document that the current `reward_campaigns.id` is
the settlement ID and is not a generalized Campaign product entity.

## 3. Slice V2C.1A - Contracts and Poll Adapter Tests

**Commit:** `feat(v2c1): add shared participation contracts and Poll adapter`

### 3.1 Files

Add:

- `src/lib/rewards/participation.ts`
- `src/lib/rewards/participation.test.ts`
- `src/lib/rewards/poll-participation-adapter.ts`
- `src/lib/rewards/poll-participation-adapter.test.ts`

Do not modify a route or database file in this slice. The adapter may expose an
injected store and a Supabase store factory for the next slice, but no runtime
caller should invoke it yet.

### 3.2 RED tests

In `participation.test.ts`, add pure contract tests for:

- `poll_vote` and `campaign_claim` are the only source types.
- Source ID, participant wallet, owner wallet, evidence ID, evidence kind,
  server verification time, settlement ID, and binding are required.
- Settlement ID is distinct from the source evidence ID.
- A context has no reward amount, capacity, vault, state,
  `firstReservationAt`, `optionId`, or selected-option field.
- A browser-shaped object with client economics, recipient, owner, or selected
  option is rejected by the runtime constructor/validator if one is added.
- No constructor imports a route, parses a browser request, calls a wallet, or
  performs a database mutation.

In `poll-participation-adapter.test.ts`, use a fake store with only source and
binding records. Add tests for:

- a committed durable vote with a verified matching session resolves an eligible
  `poll_vote` context;
- `poll_votes.id` is the evidence/source ID for participation;
- the attached `reward_campaigns.id` is the settlement ID, not the Poll ID;
- the binding is `reward_campaigns.poll_id = poll_votes.poll_id`;
- participant and owner addresses are normalized with the repository path;
- a session-wallet mismatch fails closed;
- a missing vote, Poll ID mismatch, missing Poll, or malformed wallet fails closed;
- private/non-public Polls fail closed;
- `legacy_support` Polls fail closed even if a reward row exists;
- `reward_first` with `free` mode fails closed;
- only `reward_first` with `rewarded` mode can resolve eligibility;
- a creator vote is a valid source vote but returns creator-ineligible without a
  reward context;
- missing or mismatched Poll-to-settlement binding fails closed;
- selected option data is not accepted by the request or returned by the context;
- the store request does not load amount, capacity, vault, settlement state, or
  `first_reservation_at` to establish Poll eligibility.

The Poll adapter request must contain a verified server session shape equivalent
to `{ address: string }`, plus the route Poll ID and the successful vote ID. It
must not contain `optionId`; that value ends at `cast_poll_vote_atomic`.

### 3.3 GREEN implementation

Implement `PollRewardParticipationAdapter` with an injected source store:

```ts
interface PollRewardParticipationStore {
  loadVote(voteId: string): Promise<{
    id: string;
    pollId: string;
    participantWallet: string;
    committed: boolean;
  } | null>;
  loadPoll(pollId: string): Promise<{
    id: string;
    creatorWallet: string;
    economicModel: string | null;
    rewardMode: string | null;
    isPublic: boolean;
    status: string;
  } | null>;
  loadSettlementBinding(pollId: string): Promise<{
    settlementId: string;
    pollId: string;
  } | null>;
}
```

The Supabase store may query `poll_votes`, `polls`, and only
`reward_campaigns.id,poll_id` for the current compatibility binding. It must
not select reward terms or vault columns. Resolve in this order:

1. Load the durable vote and require its `pollId` to equal the route Poll ID.
2. Normalize the session address and vote wallet and require equality.
3. Load the Poll and require public status plus the current `live`/`closed`
   source rule.
4. Require exactly `economic_model = "reward_first"` and
   `reward_mode = "rewarded"`.
5. Exclude the creator from reward eligibility while allowing the Poll vote.
6. Load only the settlement ID/binding and require it matches the Poll vote.
7. Build the minimal context with server `verifiedAt` and no option data.

The adapter must return an ineligible result before settlement binding lookup
for free, legacy, private, or creator-ineligible cases where the binding is not
needed. It must not infer eligibility from a non-null reward row.

### 3.4 Verification

Run:

```text
npm test -- src/lib/rewards/participation.test.ts src/lib/rewards/poll-participation-adapter.test.ts
npx tsc --noEmit
npm run lint
```

The slice is GREEN only when the new tests and type/lint checks pass without
changing the Poll route or any database behavior.

### 3.5 Refactor check

- Keep the contracts server-only.
- Keep source-specific Poll queries inside the Poll adapter/store.
- Keep settlement ID distinct from source/evidence ID.
- Do not add a Campaign fixture, Campaign type, Campaign table, or Campaign route.
- Do not use `as` to bypass the minimal context shape.

## 4. Slice V2C.1B - Reservation Boundary Extraction

**Commit:** `feat(v2c1): extract shared reward reservation boundary`

### 4.1 Files

Add:

- `src/lib/rewards/reservation-service.ts`
- `src/lib/rewards/reservation-service.test.ts`

Modify:

- `src/app/api/polls/[pollId]/vote/route.ts`
- `src/app/api/polls/[pollId]/vote/route.test.ts`
- `src/lib/rewards/eligibility.ts`
- `src/lib/rewards/eligibility.test.ts`

Extend, without changing fixture authority or RPC signatures:

- `src/lib/rewards/reservation.db.test.ts`

Do not modify `supabase/migrations/*` or `src/types/database.ts`.

### 4.2 RED tests

In `reservation-service.test.ts`, add tests proving:

- the service accepts only an eligible `RewardParticipationContext`;
- it passes only `context.source.id` and `context.settlement.id` to the Poll
  compatibility RPC store;
- a context/source or context/settlement binding mismatch fails closed before
  financial mutation;
- the authoritative store reloads participant/owner/binding identity and the
  RPC remains responsible for amount, capacity, vault, state, and
  `first_reservation_at`;
- reserved and replay results expose receipt identity/status but not client
  economics or selected-option data;
- no-capacity, creator-ineligible, free, legacy, closed, unfunded, or malformed
  results do not create a receipt;
- a reservation failure is safe for the caller to treat as best-effort.

Extend `eligibility.test.ts` with the missing compatibility assertion:

- a `legacy_support` Poll with a non-null historical campaign is not eligible.

Update `route.test.ts` to mock the adapter and reservation service rather than
the route's direct `reward_campaigns` lookup. Keep tests for:

- a successful Poll vote returning the existing `201` response;
- a reservation failure leaving the vote response successful;
- a free Poll creating no reward work;
- payout being attempted only after a reserved/replay receipt with the existing
  automatic behavior;
- no client reward amount, owner, recipient, capacity, or vault reaching the
  service call.

Extend `reservation.db.test.ts` only where needed to assert that the extracted
boundary preserves the existing RPC behavior:

- one receipt per canonical participant;
- replay is checked before capacity;
- only one concurrent final-slot reservation succeeds;
- `first_reservation_at` is set once;
- creator participation remains a valid vote but creates no reward;
- free and legacy Polls are rejected even if a campaign row exists;
- Poll/campaign and participation/campaign mismatches do not mutate either side;
- the authoritative campaign amount is used;
- no browser amount override is accepted.

### 4.3 GREEN implementation

Implement `RewardReservationService` with a store interface that separates
identity validation from the atomic financial call:

```ts
interface RewardReservationStore {
  loadAuthority(context: RewardParticipationContext): Promise<{
    sourceId: string;
    sourceType: "poll_vote";
    settlementId: string;
    bindingSourceId: string;
    participantWallet: string;
    ownerWallet: string;
  } | null>;
  reserveAtomic(sourceId: string, settlementId: string): Promise<unknown>;
}
```

The Poll compatibility store must call exactly:

```text
claim_reward_receipt_atomic(
  _participation_id = context.source.id,
  _campaign_id = context.settlement.id,
)
```

It must parse only the safe result kind, receipt ID, receipt status, and
settlement identity needed by the service. The RPC response's reward amount is
not used as client authority.

The route flow becomes:

```text
verified session
  -> cast_poll_vote_atomic
  -> PollRewardParticipationAdapter.resolveParticipation(vote_id)
  -> RewardReservationService.reserve(context)
  -> existing automatic payout call
```

Do not move vote recording inside reward work and do not turn a reservation or
payout error into a vote error. Preserve the current logs and safe outward
response shape.

Narrow or isolate `isRewardedPoll` in `src/lib/rewards/eligibility.ts` so it
requires both `reward_first` and `rewarded`. The legacy branch that treats any
non-null campaign as rewardable must not be reachable from the adapter or the
shared reservation path. Keep the pure helper's financial validation and
existing test semantics where they are still used, but make the discriminator
explicit rather than relying on a campaign's presence.

### 4.4 Verification

Run:

```text
npm test -- src/lib/rewards/participation.test.ts src/lib/rewards/poll-participation-adapter.test.ts src/lib/rewards/reservation-service.test.ts src/lib/rewards/eligibility.test.ts src/app/api/polls/[pollId]/vote/route.test.ts
npx tsc --noEmit
npm run lint
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/rewards/reservation.db.test.ts
```

The database command is local-only and must not run when the test environment
guard rejects the Supabase URL.

### 4.5 Refactor check

- The route still records a valid vote before reward work.
- The adapter, not `eligibility.ts`, owns Poll source eligibility.
- The reservation service does not load or carry option data.
- The SQL RPC remains the final lock, capacity, receipt, counter, and lifecycle
  authority.
- No Poll ID is mistaken for the settlement ID.

## 5. Slice V2C.1C - Settlement Context Generalization

**Commit:** `feat(v2c1): generalize reward settlement context`

### 5.1 Files

Add:

- `src/lib/rewards/settlement.ts`
- `src/lib/rewards/settlement.test.ts`

Modify:

- `src/app/api/polls/[pollId]/vote/route.ts`
- `src/app/api/polls/[pollId]/reward/funding/intents/route.ts`
- `src/app/api/polls/[pollId]/reward/funding/intents/[intentId]/bind/route.ts`
- `src/app/api/polls/[pollId]/reward/funding/intents/[intentId]/confirm/route.ts`
- `src/app/api/polls/[pollId]/reward/payouts/[attemptId]/reconcile/route.ts`
- `src/lib/rewards/funding-confirmation.ts`
- `src/lib/rewards/payout-reconciliation.ts`
- `src/lib/rewards/funding-confirmation.test.ts`
- `src/lib/rewards/payout-reconciliation.test.ts`

Update the corresponding local DB tests:

- `src/lib/rewards/funding-confirmation.db.test.ts`
- `src/lib/rewards/payout-reconciliation.db.test.ts`
- `src/lib/rewards/payout.db.test.ts` where service-ID assertions are needed.

Do not modify the funding/payout migrations or generated database types.

### 5.2 RED tests

In `settlement.test.ts`, add tests for:

- a Poll route resolves `reward_campaigns.id` as `settlementId` without exposing
  the Poll ID as the financial identity;
- a settlement service accepts a settlement ID and delegates to the existing
  Poll-compatible RPCs/stores;
- a missing Poll-to-settlement binding fails closed;
- an unrelated receipt, payout attempt, funding intent, or vault cannot be
  reached through a different settlement ID;
- funding amount, funding wallet, vault, payout recipient, payout amount,
  network, attempt state, lease, and finality evidence are loaded from the
  current financial rows, not a source adapter or request body;
- no settlement service API accepts `optionId`, selected-option data, or client
  economics;
- payout preparation persists exact signed bytes/hash before broadcast;
- a broadcast-start marker and hash-bearing uncertainty prevent blind resend;
- only a definite hashless pre-broadcast failure remains retryable;
- finality confirmation still requires the existing observer evidence.

Update existing reconciliation tests to call loaders with a `settlementId`
instead of a Poll ID and add a negative mismatch case. The loader must not need
to read `polls` to construct funding, payout, or reconciliation context.

### 5.3 GREEN implementation

Add `src/lib/rewards/settlement.ts` as the explicit compatibility façade:

```ts
interface RewardSettlementService {
  beginFunding(settlementId: string, funderWallet: string): Promise<FundingIntentResponse | SafeSettlementError>;
  bindFunding(settlementId: string, intentId: string, funderWallet: string, transactionHash: string): Promise<unknown>;
  confirmFunding(settlementId: string, intentId: string, funderWallet: string): Promise<FundingConfirmationResult>;
  executePayout(settlementId: string, receiptId: string): Promise<RewardPayoutResult>;
  reconcilePayout(settlementId: string, attemptId: string, viewerWallet: string): Promise<PayoutReconciliationExecutionResult>;
}
```

The exact result unions may use the existing types, but service methods must
use settlement terminology at this boundary. The compatibility implementation
maps `settlementId` to the current physical `reward_campaigns.id` and leaves
the database RPC argument `_campaign_id` unchanged.

Add a Poll-only resolver in the same module or an explicitly named helper:

```text
resolvePollRewardSettlement(admin, pollId)
  -> reward_campaigns.id where reward_campaigns.poll_id = pollId
```

The Poll HTTP wrappers retain their Poll path and public checks, then pass the
resolved settlement ID to the shared service. The service and lower financial
loaders must verify that every loaded receipt/attempt/intent/refund belongs to
that settlement.

Change `loadFundingConfirmationContext` to load by settlement ID rather than
discovering the campaign through a Poll ID. Keep its outward funding response
field `campaignId` unchanged where that is a shipped read-model field; its
internal value is the current settlement ID.

Change `loadPayoutReconciliationContext` to load by settlement ID and remove
the implicit `receipt.poll_id`/`campaign.poll_id` requirement from this shared
financial loader. The Poll route resolver remains responsible for Poll-to-
settlement binding. The atomic confirmation RPC still receives the current
settlement ID through `_campaign_id` and remains service-role-only.

Keep existing `RewardPayoutStore`, `runRewardPayout`, vault signing, funding
confirmation, payout reconciliation, observation, and retry algorithms intact
unless a parameter name or loader query must change. Do not rename physical
database columns merely to make them sound generic. `campaignId` in a lower
store snapshot is a documented compatibility name for `settlementId`.

Update the vote route to call `settlementService.executePayout` after the
reservation result. This must preserve automatic payout and all best-effort
error behavior from V2C.1B.

### 5.4 Verification

Run:

```text
npm test -- src/lib/rewards/settlement.test.ts src/lib/rewards/funding-confirmation.test.ts src/lib/rewards/payout.test.ts src/lib/rewards/payout-reconciliation.test.ts src/app/api/polls/[pollId]/vote/route.test.ts
npx tsc --noEmit
npm run lint
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/rewards/funding-confirmation.db.test.ts src/lib/rewards/payout.db.test.ts src/lib/rewards/payout-reconciliation.db.test.ts
```

### 5.5 Refactor check

- Shared settlement methods have no Poll lifecycle or option semantics.
- Poll IDs enter only through the Poll compatibility resolver/wrapper.
- `reward_campaigns.id` is consistently treated as the current settlement ID.
- Funding and payout route response shapes remain unchanged.
- No client economics reach a funding, payout, signing, broadcast, or finality
  boundary.
- Vault key material remains inside `withCampaignVaultKey`.

## 6. Slice V2C.1D - Closure and Refund Context Generalization

**Commit:** `feat(v2c1): extract shared closure and refund boundary`

### 6.1 Files

Add:

- `src/lib/rewards/closure.ts`
- `src/lib/rewards/closure.test.ts`
- `src/lib/rewards/poll-closure-adapter.ts`
- `src/lib/rewards/poll-closure-adapter.test.ts`

Modify:

- `src/lib/rewards/participation.ts`
- `src/lib/rewards/refund-policy.ts`
- `src/lib/rewards/refund-policy.test.ts`
- `src/lib/rewards/refund-reconciliation.ts`
- `src/lib/rewards/refund-reconciliation.test.ts`
- `src/app/api/polls/[pollId]/reward/refund/route.ts`
- `src/app/api/polls/[pollId]/reward/refund/[refundId]/reconcile/route.ts`

Update the corresponding local DB tests:

- `src/lib/rewards/refund-preparation.db.test.ts`
- `src/lib/rewards/refund.db.test.ts`
- `src/lib/rewards/refund-reconciliation.db.test.ts`

Do not add a generic closure/refund RPC or migration in this slice.

### 6.2 RED tests

In `poll-closure-adapter.test.ts`, add tests for:

- a closed Poll maps to a source-neutral `source_closed` trigger;
- a live Poll whose end time has elapsed maps to `elapsed`;
- an active unelapsed Poll cannot produce a close trigger;
- the trigger source identity is the Poll lifecycle source ID, not an arbitrary
  vote or browser value;
- the current settlement binding is included as the settlement ID plus source
  binding;
- `observedAt` is server-created;
- no amount, vault, balance, obligations, settlement state, or session token is
  in the trigger;
- a Poll/campaign binding mismatch fails closed;
- creator authorization is checked separately and is not encoded as a client
  destination or financial snapshot.

In `closure.test.ts`, add tests for:

- only a server-produced `RewardClosureContext` reaches the closure service;
- the service revalidates source/binding identity before calling the Poll
  compatibility store;
- the session token hash is passed only through a separate server-only
  authorization argument;
- the compatibility store calls
  `begin_reward_refund_atomic(_campaign_id, _session_token_hash)` and does not
  accept client amount, destination, vault, or closable fields;
- replay, blocked obligations, reconciliation-required, invalid accounting,
  zero remainder, and positive remainder results remain safe and idempotent;
- positive refund preparation freezes the settlement before execution;
- `executeRefund` delegates to existing `runRewardRefund` with the settlement
  ID and does not sign or broadcast in the closure policy layer.

In `refund-policy.test.ts`, update the imported type name to the renamed
`RewardPolicyClosureTrigger` and retain all existing cases for unresolved
obligations, reconciliation evidence, fee accounting, zero remainder, positive
remainder, cancellation freeze, and finality-independent pure calculation.

Add tests to `refund-reconciliation.test.ts` proving the loader accepts a
settlement ID, rejects a refund belonging to another settlement, and preserves
the existing exact sender/recipient/amount/finality proof boundary.

### 6.3 GREEN implementation

In `refund-policy.ts`, rename only the existing Poll/financial trigger union to
`RewardPolicyClosureTrigger` and keep the pure policy's behavior unchanged. Do
not make the pure accounting function inspect a source-neutral trigger or Poll
option.

Implement `PollRewardClosureAdapter` with an injected source store that reads
only Poll lifecycle and the Poll-to-settlement identity needed to produce a
trigger. For V2C.1, `source.id` is the Poll lifecycle source ID because closure
is a property of the Poll source, while a participation context's
`source.id` remains the durable `poll_votes.id`. Document this distinction in
the adapter types and tests; do not use a fabricated vote as a closure source.

Implement `RewardClosureService` with these rules:

1. Accept a source-neutral trigger and separate server authorization.
2. Revalidate source/binding identity and acquire the settlement lock through
   the compatibility boundary.
3. Let the current `begin_reward_refund_atomic` remain the final Poll-bound
   authority for creator authorization, Poll close/elapsed checks, unresolved
   obligations, confirmed fee accounting, exact remainder, freeze, and refund
   intent creation.
4. Parse safe result kinds and preserve current route status/error behavior.
5. For a created or replayed refund, call the existing `executeRewardRefund`
   using the settlement ID.
6. Never allow a trigger or request body to choose refund amount, recipient,
   vault, fee, balance, or terminal state.

The existing Poll refund route becomes:

```text
verified creator session
  -> resolve Poll settlement binding
  -> PollRewardClosureAdapter
  -> RewardClosureService.prepareRefund(trigger, server authorization)
  -> existing RewardSettlementService.executeRefund
```

The body remains ignored. No Campaign closure route or cancellation endpoint is
added. The current RPC remains responsible for the existing creator-cancelled
state policy; V2C.1 does not invent a new cancellation source flow.

Change `loadRefundReconciliationContext` to load by settlement ID, not a Poll
ID, and remove Poll lifecycle from the shared refund reconciliation loader. The
Poll route resolver still prevents a Poll URL from reaching another settlement.
Keep `refund.ts`'s exact durable preparation, vault lease, broadcast marker,
unknown-outcome, and retry behavior. Its physical `campaignId` arguments remain
compatibility names for the current settlement ID.

### 6.4 Verification

Run:

```text
npm test -- src/lib/rewards/closure.test.ts src/lib/rewards/poll-closure-adapter.test.ts src/lib/rewards/refund-policy.test.ts src/lib/rewards/refund-reconciliation.test.ts
npx tsc --noEmit
npm run lint
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/rewards/refund-preparation.db.test.ts src/lib/rewards/refund.db.test.ts src/lib/rewards/refund-reconciliation.db.test.ts
```

### 6.5 Refactor check

- Source lifecycle is mapped by the Poll adapter; financial closure is owned by
  the closure service and existing atomic RPC.
- `RewardClosureContext` contains no financial or authentication snapshot.
- `RewardPolicyClosureTrigger` remains private to pure Poll reward policy.
- Refund preparation still blocks unresolved/hash-bearing/manual-review work.
- Refund signing/broadcast/finality still uses the same vault and observation
  boundaries as payout.
- No generic Campaign closure or schema work has slipped into the slice.

## 7. Slice V2C.1E - Poll Compatibility and Full Regression Gate

**Commit:** `test(v2c1): verify Poll compatibility and regression gate`

### 7.1 Files

Add:

- `src/lib/rewards/v2c1-compatibility.test.ts`

Modify only if the preceding slices leave a real assertion gap:

- `src/app/api/polls/[pollId]/vote/route.test.ts`
- `src/lib/rewards/reservation.db.test.ts`
- `src/lib/rewards/payout.db.test.ts`
- `src/lib/rewards/refund-preparation.db.test.ts`
- `src/lib/rewards/refund-reconciliation.db.test.ts`

Do not modify UI, public Poll serializers, Poll creation, support routes, or
database files for this final slice unless a regression fix is directly proven
by a failing compatibility test. V2C.1 is not a UI or product alignment slice.

### 7.2 RED tests and static review

The compatibility test must assert:

- free Polls create no reward campaign, receipt, funding obligation, payout
  attempt, refund, or participant support contribution;
- legacy support Polls remain distinct and historical reward rows cannot enter
  the Poll reward adapter;
- rewarded reward-first Polls retain automatic payout after voting;
- creator votes remain valid Poll votes but never create a reward receipt;
- a valid vote remains committed when reservation or payout work fails;
- replay does not create a second receipt or payout attempt;
- exhausted capacity does not invalidate the already-committed vote;
- selected option does not appear in shared context, receipt, payout, refund,
  reconciliation, profile metric, or public reward proof data;
- funding remains designated-wallet authorized and pending until observed finality;
- payout remains exact-transfer, server-signed, lease-serialized, retry-bounded,
  and finality-gated;
- refund remains creator-authorized, unresolved-obligation-gated, accounting-
  checked, freeze-protected, and finality-gated;
- no browser request shape can provide authoritative economics or a context;
- no file under `supabase/migrations/` was added or changed;
- no `participation_campaigns`, Campaign route, Campaign fixture, or Campaign
  implementation was added.

Use source inspection assertions and repository searches for the final review:

```text
rg "option_id|selectedOptionId|selected-option|winner|majority" src/lib/rewards src/app/api/polls
rg "participation_campaigns|CampaignClaim|campaign_claim|Secret Drop|Private Drop|Event Drop|Community Reward" src supabase
rg "RewardParticipationContext|RewardClosureContext|RewardSettlementContext" src
```

Every match must be classified as Poll-specific source data, an internal
contract, existing compatibility code, or an out-of-scope future design
reference. No selected option may cross the Poll source boundary.

### 7.3 GREEN gate

Run the complete established local-only sequence in this order:

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

Run the full Vitest suite with the local database guard. Run the versioned
script suites only against local Supabase. If a local suite is unavailable,
record the exact skipped command and environment reason; never substitute a
hosted target.

### 7.4 Refactor check

- Review the diff for Poll response and route behavior changes.
- Review all new service imports for `server-only` boundaries.
- Review all current lower financial services for accidental client imports,
  browser-deserialized contexts, Poll option reads, or source-specific branches.
- Confirm no `src/types/database.ts` or migration diff exists.
- Confirm protected worktree files remain untouched and unstaged.
- Confirm no Campaign product behavior is claimed by the tests or output.

## 8. Commit and Delivery Order

The implementation agent must commit each completed slice separately, after that
slice's RED/GREEN/refactor checks pass:

1. `feat(v2c1): add shared participation contracts and Poll adapter`
2. `feat(v2c1): extract shared reward reservation boundary`
3. `feat(v2c1): generalize reward settlement context`
4. `feat(v2c1): extract shared closure and refund boundary`
5. `test(v2c1): verify Poll compatibility and regression gate`

Do not begin V2C.2 Campaign entity work until V2C.1E passes. Do not use a
Campaign fixture, table, route, or fake Campaign adapter to prove any slice.

For this plan-only task, after writing and reviewing this file:

```text
git diff --check
git status --short
git diff -- docs/superpowers/plans/2026-09-13-v2c1-shared-nim-participation-engine-implementation.md
git add docs/superpowers/plans/2026-09-13-v2c1-shared-nim-participation-engine-implementation.md
git commit -m "docs(v2c1): plan shared NIM participation engine"
git push origin feat/v2-participation-record
git status --short
```

Stage only the plan file. Do not stage protected files or unrelated changes.

## 9. Definition Of Done

- Five independently testable TDD slices are documented with exact files,
  symbols, tests, commands, interfaces, and commit messages.
- The Poll adapter is the only runtime source implemented by V2C.1.
- `RewardParticipationContext` is minimal and server-only.
- Reservation, settlement, and closure services reload financial authority from
  current database rows and preserve existing lock/RPC boundaries.
- Poll vote, automatic payout, funding, payout, reconciliation, and refund route
  behavior remains compatible.
- Legacy support, free reward-first, and rewarded reward-first semantics remain
  distinct.
- No selected option enters reward economics, financial records, or proof.
- No database migration, generated type update, Campaign entity, Campaign route,
  UI change, NIM transfer, hosted database operation, or physical QA occurs.
- The full V2B.2.13 regression sequence, typecheck, lint, build, and local-only
  suites are required before implementation completion.
- This documentation-only delivery contains only the plan file in its commit.
