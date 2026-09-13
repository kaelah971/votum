# V2C.2 Campaign Foundation and Generic Settlement Root Implementation Plan

**Status:** Implementation plan only. This document does not implement
Campaigns, migrations, routes, UI, claim flows, NIM transfers, deployment, or
physical wallet QA.

**Design authority:**
`docs/superpowers/specs/2026-09-13-v2c2-campaign-foundation-design.md`

**Approved design commit:** `d914574 docs(v2c2): root reward vaults on settlements`

**Branch:** `feat/v2-participation-record`

**Execution rule:** Each slice is implemented in an isolated commit. Write the
 failing unit, route, static, or local database assertion first (RED), run it
 and record the expected failure, implement the smallest change that makes that
 assertion pass (GREEN), run the focused checks and adjacent regressions, then
 commit the slice and stop for review. Do not start the next slice until the
 preceding commit and its gate are reviewed.

## 1. Guardrails and Baseline

### 1.1 Scope

Implement only the V2C.2 Campaign foundation and generic settlement-root
transition:

- `reward_settlements` as the single mutable financial root after cutover;
- `participation_campaigns` as the product/configuration entity;
- explicit Poll/Campaign source bindings;
- additive settlement references on existing financial children;
- settlement-rooted vault custody while preserving existing Poll envelopes;
- creator draft/configuration and funding-readiness server boundaries;
- Poll compatibility through the existing public routes and response aliases;
- guarded Phase A snapshot, Phase B validation, Phase C resync, Phase D switch,
  and Phase E freeze.

Do not implement:

- `campaign_claims` or any participant Campaign flow;
- claim identity, nonce, Campaign-bound wallet challenges, or eligibility
  strategies;
- secret, allowlist, event-proof, QR/deep-link, or community-membership tables;
- Campaign discovery, ranking, public proof, or UI;
- creator financial management, Campaign close/refund/retry/manual-review UI;
- NIM transfer, Nimiq Pay, chain observation for a new Campaign, deployment,
  physical wallet approval, or production rollout;
- betting, prediction-market, gambling, winner-takes-pot, or pooled-prize
  semantics.

### 1.2 Non-negotiable compatibility rules

- Keep `reward_campaigns.poll_id NOT NULL UNIQUE` and its Poll FK.
- Do not turn `reward_campaigns` into the Campaign product table.
- Do not add a nullable Poll/Campaign mega-row or a second financial ledger.
- Preserve existing Poll IDs, vote IDs, receipt IDs, funding IDs, payout IDs,
  refund IDs, transaction hashes, Poll URL shapes, and public response aliases.
- Keep Poll voting at `POST /api/polls/[pollId]/vote`.
- Keep rewarded `reward_first` Poll payout automatic and Claim-free.
- Preserve valid Poll vote success when reservation or payout follow-up fails.
- Keep free `reward_first` Polls and `legacy_support` Polls reward-ineligible.
- Keep creator votes valid as Poll votes but reward-ineligible.
- Keep `option_id` and all selected-option data at the Poll boundary. It must not
  enter settlement, receipt, payout, refund, reconciliation, proof, or Campaign
  contracts.
- Derive owner, funder, reward amount, cap, fee reserve, total budget, refund
  destination, settlement ID, and vault relationship server-side.
- Treat `reward_campaigns.vault_wallet` and `reward_campaigns.vault_key_ref` as
  deprecated historical fields. They are never copied into a root or used as
  post-cutover vault authority.
- Keep `reward_funding_transactions.vault_wallet` as an immutable funding-intent
  snapshot and validate it against the settlement-rooted vault address.
- Keep all money as integer Luna in PostgreSQL `bigint` and server `bigint`.
- Keep all financial and vault tables service-role-only with RLS and revoked
  `anon`/`authenticated` table access.

### 1.3 Protected worktree files

Do not modify or stage these existing worktree files:

- `next.config.ts`
- `.env.local`
- `dev-server-t12.log`
- `dev-server-t12.err.log`
- `scripts/seed-device-qa-fixtures.ts`

If one of these changes during implementation, leave it untouched and report it
separately.

### 1.4 Current repository map

The existing V2C.1 Poll path is:

```text
verified wallet session
  -> cast_poll_vote_atomic
  -> PollRewardParticipationAdapter
  -> RewardReservationService
  -> claim_reward_receipt_atomic
  -> RewardSettlementService.executePayout
  -> executeReservedRewardPayout
```

The current implementation still reads the physical Poll-shaped root:

- `src/lib/rewards/settlement.ts` loads `reward_campaigns` and
  `reward_campaign_vaults`.
- `src/lib/rewards/reservation-service.ts` validates a Poll vote/campaign pair
  and calls `claim_reward_receipt_atomic`.
- `src/lib/rewards/funding-confirmation.ts` loads a campaign, funding intent,
  and campaign vault by campaign ID.
- `src/lib/rewards/payout-reconciliation.ts` loads campaign, receipt, and vault
  by campaign ID, then reconciles through `reward_payout_attempts`.
- `src/lib/rewards/refund-reconciliation.ts` does the equivalent for refunds.
- `src/lib/rewards/vault-service.ts` exposes `ensureCampaignVault`,
  `getCampaignVault`, and `withCampaignVaultKey` keyed by campaign ID.
- `src/lib/rewards/vault-key.ts` builds AAD from
  `votum:reward-vault:v1`, the campaign UUID, and the lowercase vault address.
- `src/lib/data/public-polls.ts` and `src/lib/data/explore-queries.ts` call
  `get_public_reward_campaign(_poll_id)`.
- Poll publication and reward configuration create/update
  `reward_campaigns` and call `ensureCampaignVault`.

The V2C.1 contracts already exist in:

- `src/lib/rewards/participation.ts`;
- `src/lib/rewards/poll-participation-adapter.ts`;
- `src/lib/rewards/reservation-service.ts`;
- `src/lib/rewards/settlement.ts`;
- `src/lib/rewards/closure.ts`;
- `src/lib/rewards/poll-closure-adapter.ts`.

The generated database type file is `src/types/database.ts`. `package.json` has
no type-generation script; use the Supabase CLI local type-generation command
from the repository root and never hand-edit generated output.

### 1.5 Baseline and local-only commands

The V2C.1 recorded baseline is the comparison point:

- Full Vitest: 57 files, 621 tests passed.
- Focused V2C.1 reward/adapter/closure/financial suites: 11 files, 162 tests
  passed.
- Local schema gate: 59 passed.
- Local creator configuration gate: 75 passed.
- Local funding gate: 57 passed.
- Local persisted vault gate: 16 passed.
- Local V2B.1 backward-compatibility gate: 59 passed.
- Lint, typecheck, and production build passed.

Before implementation, record a fresh baseline when local services are
available:

```text
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism
npm run lint
npx tsc --noEmit
npm run build
npx tsx src/lib/api/v2b2-schema-test.ts
npx tsx src/lib/api/v2b2-config-test.ts
npx tsx src/lib/api/v2b2-funding-test.ts
npx tsx src/lib/api/v2b2-vault-test.ts
npx tsx src/lib/api/v2b1-backward-test.ts
npx tsx src/lib/api/publish-test.ts
```

Every database test must call `assertLocalSupabaseForTests()` from
`src/lib/rewards/test-env.ts`. Use only the local `supabase_db_votum` target.
If local Supabase is unavailable, report the exact database command as skipped;
do not redirect it to a hosted database.

The allowed local migration flow is:

1. Verify `npx supabase status` reports the local project and that the test URL
   is local.
2. Apply pending migrations with `npx supabase migration up`; never use
   `supabase db reset`, `supabase db push`, `supabase link`, `--linked`, hosted
   Supabase, migration repair, or fake migration registration.
3. Run the focused local DB test against the resulting schema.
4. Generate types only with `npx supabase gen types typescript --local` after
   the intended migration is applied, writing only `src/types/database.ts`.
5. Stop the local Supabase service after DB gates complete.

Existing local migration drift is evidence to report, not a reason to reset,
repair, or fabricate migration history.

## 2. Target Model and Contract Ledger

### 2.1 Target relationship model

```text
polls
  -> reward_campaigns (Poll adapter, poll_id remains NOT NULL UNIQUE)
  -> settlement_source_bindings
  -> reward_settlements

participation_campaigns (Campaign product/configuration)
  -> settlement_source_bindings
  -> reward_settlements

reward_settlements
  -> reward_funding_transactions.settlement_id
  -> reward_receipts.settlement_id
       -> reward_payout_attempts.receipt_id
  -> reward_refunds.settlement_id
  -> reward_campaign_vaults.settlement_id
```

`settlement_source_bindings` contains only source identity and the exact-one
source relationship. It contains no money, balances, vault material, secrets,
allowlist data, event proof, or product presentation.

Historical Poll rows receive a root with the same UUID as the existing
`reward_campaigns.id`. New Poll reward offers may use a separate root UUID, but
the Poll adapter must always resolve `poll_id -> reward_campaigns -> binding ->
settlement_id`; it must never use a Poll ID as a settlement ID.

### 2.2 Settlement root fields and invariants

Create `reward_settlements` with the exact fields and checks from the design:

- `id uuid PRIMARY KEY`;
- canonical lowercase 40-hex `owner_wallet`, `funding_wallet`, and
  `refund_recipient_wallet`;
- `funding_mode` in `creator|community`;
- `asset = 'NIM'`;
- integer-Luna reward, principal, fee reserve, total budget, capacity, balance,
  accounting, state, payout lease, and lifecycle timestamps;
- principal equals reward-per-participant times maximum participants;
- total budget equals principal plus fee reserve;
- creator funding requires `funding_wallet = owner_wallet`;
- refund destination is owner or designated funder;
- no overspend and bounded participant count;
- statuses remain `configured`, `funding_pending`, `funded`, `rewarding`,
  `exhausted`, `closed`, `refunding`, `refunded`, or `cancelled`.

The root has no private key, ciphertext, IV, authentication tag, vault key
reference, or vault address authority.

### 2.3 Campaign product fields and invariants

Create `participation_campaigns` with:

- `id uuid PRIMARY KEY`;
- immutable one-to-one `settlement_id uuid NOT NULL UNIQUE`;
- canonical lowercase 40-hex `owner_wallet`;
- exactly `public_giveaway`, `secret_drop`, `private_drop`, `event_drop`, or
  `community_reward` as `campaign_type`;
- `public|unlisted|private` visibility;
- title, optional description, product status, configuration versions,
  publication lock markers, optional window, close reason, and timestamps;
- title, description, window, status, and version constraints from the design;
- no balance, reward amount, funding transaction, receipt, payout, refund, vault,
  claim, secret, allowlist, event, QR, or community membership field.

Product status and financial status remain separate. `published` does not mean
funded or claimable. No V2C.2 Campaign participant path exists.

### 2.4 Vault compatibility contract

The final `reward_campaign_vaults` authority is:

- `settlement_id uuid NOT NULL PRIMARY KEY REFERENCES reward_settlements(id)`;
- nullable `campaign_id REFERENCES reward_campaigns(id)`;
- partial unique index on non-null `campaign_id`;
- unchanged `vault_address_hex`, envelope version, algorithm, ciphertext, IV,
  authentication tag, and timestamps;
- Poll rows retain `settlement_id = campaign_id` and the existing campaign FK;
- standalone Campaign rows use `campaign_id IS NULL`.

Before V2C.2E, `campaign_id` remains the physical primary key and runtime
authority. The constraint swap happens only in Slice E after final resync and
validation.

Preserve these exact cryptographic bytes:

```text
UTF-8("votum:reward-vault:v1\0<UUID>\0<lowercase-vault-address>")
```

The UUID for an existing Poll is the unchanged `reward_campaigns.id`, so
settlement-rooted decryption must use the same AAD bytes. Do not add an AAD
version, change serialization, rewrite an envelope, or regenerate a Poll vault.

### 2.5 Internal server-only contracts

Keep the existing minimal `RewardParticipationContext` unchanged for V2C.2.
Future Campaign adapters are type-only in this version and must not be invoked.
It may contain source ID, canonical participant/owner identity, server evidence,
settlement ID, and source binding only.

Add or update the following internal settlement-root contracts without exposing
them through browser responses:

```ts
export interface RewardSettlementRoot {
  settlementId: string;
  ownerWallet: string;
  fundingWallet: string;
  refundRecipientWallet: string;
  fundingMode: "creator" | "community";
  asset: "NIM";
  rewardPerParticipantLuna: bigint;
  maxRewardedParticipants: number;
  rewardPrincipalLuna: bigint;
  feeReserveLuna: bigint;
  totalBudgetLuna: bigint;
  status: RewardCampaignState;
}

export interface PollSettlementBinding {
  settlementId: string;
  rewardCampaignId: string;
  pollId: string;
  sourceType: "poll_reward_campaign";
}

export interface CampaignSettlementBinding {
  settlementId: string;
  participationCampaignId: string;
  sourceType: "participation_campaign";
}

export interface SettlementVaultPublic {
  settlementId: string;
  vaultAddressHex: string;
  vaultAddressNq: string;
  created: boolean;
}

export interface RewardSettlementVaultService {
  ensureRewardSettlementVault(settlementId: string): Promise<SettlementVaultPublic>;
  getRewardSettlementVault(settlementId: string): Promise<SettlementVaultPublic | null>;
  withRewardSettlementVaultKey<T>(
    settlementId: string,
    callback: (keypair: KeyPair) => T | Promise<T>,
  ): Promise<T>;
}
```

The `RewardSettlementService` methods in `src/lib/rewards/settlement.ts` keep
settlement terminology at the service boundary:

```ts
beginFunding(settlementId, funderWallet)
bindFunding(settlementId, intentId, funderWallet, transactionHash)
confirmFunding(settlementId, intentId, funderWallet)
executePayout(settlementId, receiptId)
reconcilePayout(settlementId, attemptId, viewerWallet)
```

Existing `campaignId` names may remain inside lower compatibility snapshots and
RPC argument names only when required by shipped Poll callers. Document that
the value is the current settlement ID and make the root lookup authoritative.

## 3. Migration Order and Authority Phases

Implement these migrations in exactly this order:

1. `20260913080000_v2c2_reward_settlements.sql`
2. `20260913081000_v2c2_poll_settlement_backfill.sql`
3. `20260913082000_v2c2_settlement_child_references.sql`
4. `20260913083000_v2c2_participation_campaigns.sql`
5. `20260913084000_v2c2_campaign_settlement_binding.sql`
6. `20260913085000_v2c2_financial_root_cutover.sql`
7. `20260913086000_v2c2_poll_read_root_cutover.sql`

### 3.1 Phase A: snapshot

`reward_campaigns` remains the sole financial authority. Create root snapshots
and Poll bindings, but do not change a financial service, RPC, vault lookup, or
Poll route to read root values as authority.

### 3.2 Phase B: verify

Prove all of the following before cutover:

- one root per existing reward campaign with stable UUID;
- one Poll binding per Poll reward campaign;
- canonical wallet preflight has no invalid values or normalization collisions;
- owner, funder, refund policy, Poll, root, binding, child, and vault identities
  agree under canonical comparison;
- all financial child settlement references have complete coverage;
- every transaction hash remains unique across funding, payout, refund, support,
  and contribution ledgers;
- exactly one vault maps to each settlement;
- every vault envelope value and address is unchanged;
- accounting and state invariants hold.

### 3.3 Phase C: resync

Immediately before the authority switch, block financial writes through the
deployment/migration gate, lock each current `reward_campaigns` row, copy its
current authoritative terms, balances, state, lease, and timestamps into the
matching root, and validate again. Never cut over from a stale Phase A snapshot.

### 3.4 Phase D: switch

In the guarded cutover migration and matching service changes:

- make root fields the only mutable financial authority;
- make all current financial RPCs read/write roots and settlement child columns;
- switch vault creation, loading, decrypt, signing, and reconciliation to
  settlement ID;
- swap vault primary identity to `settlement_id` and allow null Poll compatibility
  `campaign_id`;
- keep existing physical RPC names and outward aliases where necessary, but make
  their `_campaign_id` compatibility value a settlement ID;
- prevent requests from observing mixed mutable old/new authority.

### 3.5 Phase E: freeze

Retain old `reward_campaigns` financial columns only as frozen historical/read
compatibility data. Do not refresh, dual-write, or treat them as a second ledger.
Move Poll public reads through the Poll adapter, binding, and root while keeping
the existing allowlisted response shape.

### 3.6 Backfill failure policy

Abort transactionally on invalid or ambiguous wallet identity, normalization
collision, owner/funder mismatch, Poll/binding mismatch, child mismatch, hash
collision, missing/duplicate vault, envelope mutation, accounting violation, or
incomplete coverage. Corrections after cutover require a forward migration; do
not restore dual authority or use a destructive reset.

### 3.7 Required per-slice execution loop

Apply this sequence to every slice, even when the slice contains migrations:

1. Add the focused test or static assertion before the implementation.
2. Run the focused assertion and verify RED by confirming it fails for the
   intended missing contract, schema, or authority behavior rather than due to a
   setup, import, or unrelated baseline failure.
3. Implement the smallest GREEN change in the slice file set.
4. Run the focused assertion again and verify GREEN.
5. Run typecheck, lint, and the listed adjacent regression tests. For DB work,
   apply only pending migrations to local Supabase and use the local guard.
6. Inspect the diff for scope, generated type provenance, protected files, and
   authority boundaries.
7. Commit only the slice files with the exact slice commit message.
8. Stop and request review before beginning the next slice.

If RED cannot be demonstrated because the local service is unavailable, record
that fact and run the non-DB RED checks; do not weaken the assertion or use a
hosted service.

## 4. Slice V2C.2A - Settlement Root, Poll Backfill, and Bindings

**Commit:** `feat(v2c2): add settlement root and Poll source bindings`

**Review stop:** After the local migration, root/backfill, type, and focused DB
gates pass, stop and request review before adding child references.

### 4.1 Files

Add:

- `supabase/migrations/20260913080000_v2c2_reward_settlements.sql`;
- `supabase/migrations/20260913081000_v2c2_poll_settlement_backfill.sql`;
- `src/lib/rewards/settlement-root.ts`;
- `src/lib/rewards/settlement-root.test.ts`;
- `src/lib/rewards/settlement-root.db.test.ts`.

Update only through local generation:

- `src/types/database.ts`.

Do not change routes, financial services, vault service, vault RPC, or existing
financial migrations in this slice.

### 4.2 RED

Write tests before the migration and implementation. Assert:

- `auditCanonicalWalletRepresentation` uses `normalizeAddress()` and records
  source row, source column, original classification, canonical value, and
  relationship result;
- invalid historical values fail closed;
- valid alternate Nimiq forms produce a canonical comparison value without
  rewriting the old source row;
- two historical values that normalize to one identity collision block the
  backfill;
- root terms, owner, funder, refund recipient, state, balances, accounting,
  lease, and timestamps are copied exactly from each current campaign;
- each existing campaign receives a root with the same UUID;
- `reward_campaigns.poll_id` remains not-null, unique, and FK-enforced;
- each campaign gets one `poll_reward_campaign` binding and no root gets two;
- a missing campaign, missing Poll, Poll mismatch, owner mismatch, malformed
  wallet, or duplicate binding fails closed;
- no current financial reader uses root values as authority before cutover;
- no vault primary key, vault RPC, vault service lookup, ciphertext, IV, auth
  tag, envelope metadata, or vault address changes;
- `anon` and `authenticated` cannot read `reward_settlements` or bindings;
- no Campaign table, claim table, strategy table, route, or UI is added.

The DB test must use real local rows with deterministic UUIDs and clean them in
foreign-key order. It must run the preflight before attempting the backfill and
assert that a failure leaves no partial root or binding rows.

### 4.3 GREEN

Implement `20260913080000_v2c2_reward_settlements.sql`:

- create the root with the exact design fields, checks, and indexes;
- enable RLS;
- revoke all table access from `anon` and `authenticated`;
- grant only required service-role access;
- do not alter existing Poll or financial rows.

Implement `20260913081000_v2c2_poll_settlement_backfill.sql`:

- add nullable staging `reward_campaigns.settlement_id` with an FK;
- create the initial Poll-only `settlement_source_bindings` table with the Poll
  branch and exact-one constraint for that branch;
- insert one root snapshot per existing `reward_campaigns` row using its ID;
- map `creator_wallet` to root owner and refund recipient, and preserve the
  existing designated `funding_wallet` and `funding_mode` policy;
- copy all financial terms, balances, counters, statuses, leases, and timestamps;
- populate `reward_campaigns.settlement_id`;
- insert exactly one Poll binding per campaign;
- add validation indexes/constraints needed for coverage without switching
  authority;
- keep the migration transactional and fail on any SQL consistency violation.

Implement `settlement-root.ts` as `server-only`:

- `auditCanonicalWalletRepresentation(admin)` loads relevant historical wallet
  identities and returns a complete report without mutating source rows;
- `loadRewardSettlementContext(admin, settlementId)` parses a root snapshot for
  tests and future services but has no runtime caller in this slice;
- `resolvePollRewardSettlement(admin, pollId)` resolves only
  `poll_id -> reward_campaigns.id -> settlement_id` and validates the initial
  Poll binding;
- `backfillSettlementReferences`/validation helpers, if needed, remain server
  only and never become a client or route request boundary.

The application preflight is a deployment gate before the SQL backfill. The SQL
constraints and post-backfill DB assertions remain the final consistency gate;
the migration must not silently normalize or rewrite historical source columns.

### 4.4 Verification

```text
npm test -- src/lib/rewards/settlement-root.test.ts
npx supabase status
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/rewards/settlement-root.db.test.ts
npx supabase migration up
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/rewards/settlement-root.db.test.ts
npx supabase gen types typescript --local > src/types/database.ts
npx tsc --noEmit
npm run lint
```

The first DB run is expected to be RED before the new migration is applied. If
the local service is unavailable, skip and report the DB commands. Do not use a
reset or hosted target.

### 4.5 Refactor check

- Root reads are not wired into financial mutation yet.
- The Poll binding uses Poll source identity and settlement identity distinctly.
- Historical wallet columns are untouched.
- Root contains no vault material.
- No current vault value changed.
- Generated types came only from the resulting local schema.
- No protected file is changed or staged.

## 5. Slice V2C.2B - Additive Settlement Child References

**Commit:** `feat(v2c2): add settlement references to financial children`

**Review stop:** After all child coverage, hash-safety, and vault-preservation
checks pass while campaign/vault authority is still active, stop for review.

### 5.1 Files

Add:

- `supabase/migrations/20260913082000_v2c2_settlement_child_references.sql`;
- `src/lib/rewards/settlement-child-compatibility.test.ts`;
- `src/lib/rewards/settlement-child-compatibility.db.test.ts`;
- `src/lib/rewards/vault-settlement-compatibility.db.test.ts`.

Update from local generated schema:

- `src/types/database.ts`.

Extend only where assertions require it:

- `src/lib/rewards/funding-confirmation.db.test.ts`;
- `src/lib/rewards/reservation.db.test.ts`;
- `src/lib/rewards/payout.db.test.ts`;
- `src/lib/rewards/payout-reconciliation.db.test.ts`;
- `src/lib/rewards/refund-preparation.db.test.ts`;
- `src/lib/rewards/refund.db.test.ts`;
- `src/lib/rewards/refund-reconciliation.db.test.ts`;
- `src/lib/rewards/hash-safety.db.test.ts`;
- `src/lib/rewards/vault-service.test.ts`.

Do not change production service authority, route behavior, vault primary key,
or RPC semantics in this slice.

### 5.2 RED

Assert before implementation:

- `reward_funding_transactions.settlement_id`, `reward_receipts.settlement_id`,
  `reward_refunds.settlement_id`, and `reward_campaign_vaults.settlement_id`
  are additive references;
- funding, receipt, refund, and vault rows have 100 percent root coverage after
  backfill;
- non-vault references become `NOT NULL` only after coverage is proven;
- vault settlement reference stays nullable and `campaign_id` remains the
  primary/runtime lookup identity;
- each Poll vault has `settlement_id = campaign_id`;
- one settlement has exactly one vault;
- every child agrees with the Poll binding and root owner/funder relationship;
- receipt, funding, refund, and vault lookup through another settlement fails;
- payout attempts remain reached through `reward_receipts`, with no direct
  source-root column added;
- funding, payout, refund, support, and contribution transaction hash reuse
  remains blocked;
- old IDs, hashes, Poll IDs, and compatibility aliases are unchanged;
- vault ciphertext, IV, authentication tag, envelope version, algorithm, and
  address are byte-for-byte/value-for-value unchanged;
- existing Poll vaults still decrypt through `withCampaignVaultKey`;
- no child column is renamed or dropped;
- no future claim or eligibility table is created.

### 5.3 GREEN

In `20260913082000_v2c2_settlement_child_references.sql`:

- add nullable `settlement_id` FKs to funding transactions, receipts, refunds,
  and vaults;
- backfill funding, receipts, and refunds through their campaign IDs and the
  validated Poll root/binding mapping;
- backfill vaults with `settlement_id = campaign_id`;
- validate complete coverage and exact cross-row identity;
- add settlement indexes;
- make funding, receipt, and refund settlement references `NOT NULL` only after
  validation;
- keep old `campaign_id` columns and their shipped aliases;
- leave vault settlement ID nullable and leave vault `campaign_id` as the
  primary/runtime identity until Slice E;
- preserve all envelope fields without any update expression that transforms
  their values.

Add focused test helpers only as needed. They must use existing local fixture
cleanup utilities and delete children before roots. Do not make production
loaders prefer settlement IDs before the authority switch.

### 5.4 Verification

```text
npm test -- src/lib/rewards/settlement-child-compatibility.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/rewards/settlement-child-compatibility.db.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/rewards/vault-settlement-compatibility.db.test.ts
npx supabase migration up
npx supabase gen types typescript --local > src/types/database.ts
npx tsc --noEmit
npm run lint
```

Run the existing focused financial DB suites if their fixtures or generated
types changed. All DB commands remain local-only.

### 5.5 Refactor check

- Campaign-rooted authority is still intentionally active.
- Vault key lookup still uses `campaign_id`.
- New settlement references are validation projections, not a second ledger.
- No continuous dual-write was introduced.
- Existing AAD and envelope values are untouched.
- No Campaign product or participant behavior was added.

## 6. Slice V2C.2C - Participation Campaign Entity and Binding

**Commit:** `feat(v2c2): add Campaign product entity and root binding`

**Review stop:** After the Campaign schema and exact-one source binding pass,
stop for review before adding configuration APIs.

### 6.1 Files

Add:

- `supabase/migrations/20260913083000_v2c2_participation_campaigns.sql`;
- `supabase/migrations/20260913084000_v2c2_campaign_settlement_binding.sql`;
- `src/lib/campaigns/types.ts`;
- `src/lib/campaigns/entity.test.ts`;
- `src/lib/campaigns/entity.db.test.ts`.

Update from local generated schema:

- `src/types/database.ts`.

### 6.2 RED

Write tests proving:

- exactly the five approved type literals are accepted;
- invalid type, visibility, status, title, description, version, close reason,
  and time window values fail closed;
- Campaign has exactly one root settlement and one source binding;
- Campaign owner and root owner must match canonically;
- Campaign settlement ID cannot change after publication;
- owner, type, and published configuration version cannot change after
  publication;
- a root cannot bind to both Poll and Campaign source types;
- `source_type` and nullable source FKs enforce exactly one branch;
- standalone Campaign has no `poll_id` and never needs a
  `reward_campaigns` row;
- no `claimable` column exists;
- unsupported types cannot be published as claimable or enter a participant
  path;
- no Poll row is created or modified by Campaign entity writes;
- schema has no claim, secret, allowlist, event, QR, or membership fields.

### 6.3 GREEN

Implement `20260913083000_v2c2_participation_campaigns.sql` with the exact design
fields, checks, owner/type/status/window indexes, RLS, and private access
controls.

Implement `20260913084000_v2c2_campaign_settlement_binding.sql`:

- add `participation_campaign_id` and its FK to the existing binding table;
- replace the initial Poll-only constraint with the final exact-one check;
- add the Campaign/root/source consistency guard;
- enforce root owner equals Campaign owner under canonical comparison;
- reject binding changes once funding intent, reservation, or any financial child
  exists;
- reject duplicate or cross-source root ownership.

Because the Supabase JavaScript client does not make a sequence of independent
writes atomic, add the minimum service-role-only transaction functions needed by
the configuration boundary in this binding migration:

- `create_participation_campaign_atomic`: lock and validate the owner and
  derived root terms, insert one settlement, one Campaign, and one Campaign
  binding, and return their IDs; reject any Poll-row creation or client-selected
  vault ID;
- `update_participation_campaign_draft_atomic`: lock the Campaign and root,
  require draft status and no financial freeze, then update only allowed product
  and root configuration fields in one transaction;
- `publish_participation_campaign_atomic`: lock both rows, require a valid
  configuration version, freeze the product configuration, and never set a
  claimable or participant state.

These functions accept only server-derived values, validate the same constraints
as the tables, use `SECURITY DEFINER` with an empty search path, and are
executable only by `service_role`. Their exact generated signatures must be
captured in `src/types/database.ts`. No browser role may invoke them.

Implement the internal type-only definitions in `src/lib/campaigns/types.ts`:

```ts
export type ParticipationCampaignType =
  | "public_giveaway"
  | "secret_drop"
  | "private_drop"
  | "event_drop"
  | "community_reward";

export type ParticipationCampaignStatus =
  | "draft"
  | "published"
  | "closed"
  | "expired"
  | "cancelled";

export type CampaignVisibility = "public" | "unlisted" | "private";
```

Do not add a Campaign adapter, claim route, participant route, strategy
evaluation, or UI.

### 6.4 Verification

```text
npm test -- src/lib/campaigns/entity.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/campaigns/entity.db.test.ts
npx supabase migration up
npx supabase gen types typescript --local > src/types/database.ts
npx tsc --noEmit
npm run lint
```

### 6.5 Refactor check

- `reward_campaigns.poll_id` is unchanged.
- The Campaign table contains product fields only.
- The binding table contains relationship fields only.
- Owner and settlement identity are server/database checked, not client claims.
- Every unsupported type remains non-claimable.
- No private material or financial snapshot entered Campaign rows.

## 7. Slice V2C.2D - Creator Draft, Configuration, and Readiness

**Commit:** `feat(v2c2): add Campaign draft and configuration boundary`

**Review stop:** After route authorization, immutable configuration, economics,
and no-transfer readiness tests pass, stop before financial authority cutover.

### 7.1 Files

Add:

- `src/lib/campaigns/configuration.ts`;
- `src/lib/campaigns/configuration.test.ts`;
- `src/lib/campaigns/configuration.db.test.ts`;
- `src/app/api/campaigns/route.ts`;
- `src/app/api/campaigns/route.test.ts`;
- `src/app/api/campaigns/[campaignId]/route.ts`;
- `src/app/api/campaigns/[campaignId]/route.test.ts`;
- `src/app/api/campaigns/[campaignId]/publish/route.ts`;
- `src/app/api/campaigns/[campaignId]/publish/route.test.ts`;
- `src/app/api/campaigns/[campaignId]/funding-readiness/route.ts`;
- `src/app/api/campaigns/[campaignId]/funding-readiness/route.test.ts`.

Modify only if needed by the new server boundary:

- `src/lib/rewards/config.ts`;
- `src/lib/rewards/constants.ts`;
- `src/lib/rewards/settlement-root.ts`;
- `src/types/database.ts` through local generation.

Do not modify `vault-service.ts` or perform vault authority cutover here. Slice E
owns the settlement-rooted vault implementation.

### 7.2 Route contracts

Implement only these configuration routes:

```text
POST /api/campaigns
PATCH /api/campaigns/[campaignId]
POST /api/campaigns/[campaignId]/publish
GET /api/campaigns/[campaignId]/funding-readiness
```

`POST /api/campaigns` may accept title, description, type, visibility, optional
window, validated reward display input, participant cap, funding mode, and a
designated funding wallet where policy allows. It must derive owner, root,
settlement, binding, principal, fee reserve, total, and refund destination.

`PATCH` accepts only draft configuration changes. It must load the Campaign and
root, authenticate the verified session owner, enforce `draft` plus the existing
`first_reservation_at`/financial mutability boundary, and update product/root
values atomically. It must reject client-selected IDs or financial snapshots.

`POST publish` freezes product configuration and records the published version.
It may never mark a Campaign claimable: no V2C.2 type has an implemented claim
strategy, and no participant path is exposed. If the existing product policy
defines publication as claimable publication, reject unsupported types instead of
silently presenting them as usable.

`GET funding-readiness` returns only a safe readiness/read model. It may expose
Campaign ID/type/title/visibility/window/product status, policy-approved funding
readiness, and formatted NIM display values. It must not expose balances, vault
ciphertext, key material, signed bytes, chain proof, claimability, participant
data, or strategy data.

Readiness means configured integer-Luna terms, owner/funder policy, valid
root/binding, and a settlement-rooted vault relationship when the vault boundary
exists. Before Slice E, a missing Campaign vault must return not-ready; it must
not create a fake Poll `reward_campaigns` row or advertise false readiness.

### 7.3 RED

Add pure and route tests proving:

- missing session returns 401;
- owner derives only from the verified session;
- a connected wallet mismatch is rejected;
- non-owner read/update/publish returns 403;
- invalid JSON, title, description, type, visibility, window, NIM amount, and
  cap return safe validation errors;
- NIM decimal input is validated through `validateRewardConfigInput` and all
  arithmetic uses existing `computeRewardPrincipalLuna`,
  `computeFeeReserveLuna`, and `computeTotalBudgetLuna`;
- principal, fee reserve, total, funding wallet, refund recipient, root ID,
  settlement ID, and vault identity cannot be supplied authoritatively by the
  browser;
- creator funding derives funding wallet from owner;
- community funding accepts only a normalized designated funder and does not
  imply community membership;
- Campaign creation creates no `reward_campaigns` row;
- draft edits work only before publication and before the financial freeze;
- published owner/type/root/version and terms cannot be changed in place;
- root and Campaign owner mismatch fails atomically;
- unsupported types cannot be claimable or enter any participant route;
- readiness does not create a funding intent, call Nimiq Pay, observe a hash,
  confirm funding, or move NIM;
- readiness never exposes private vault fields or financial chain evidence;
- no claim, strategy, secret, allowlist, event, community, discovery, or UI
  path is added.

### 7.4 GREEN

Implement `src/lib/campaigns/configuration.ts` with:

- `createParticipationCampaign`;
- `updateParticipationCampaignDraft`;
- `publishParticipationCampaign`;
- `loadCampaignFundingReadiness`.

Use the verified session from the route boundary, canonicalize addresses with
`normalizeAddress`/`addressesEqual`, and use a server-only store. Use a single
authoritative DB transaction/RPC for creation so the root, Campaign, and source
binding cannot be partially created. The server must serialize BigInt Luna
values as decimal strings for PostgreSQL and never use unsafe browser-authored
numbers as trusted values.

Keep route response errors and safe public fields explicit. Never return root
balances, internal financial status as claimability, vault envelope fields,
session hashes, or private key material.

### 7.5 Verification

```text
npm test -- src/lib/campaigns/configuration.test.ts src/app/api/campaigns/route.test.ts src/app/api/campaigns/[campaignId]/route.test.ts src/app/api/campaigns/[campaignId]/publish/route.test.ts src/app/api/campaigns/[campaignId]/funding-readiness/route.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/campaigns/configuration.db.test.ts
npx tsc --noEmit
npm run lint
```

Run the existing Poll route/configuration tests after any shared config change.
No NIM or hosted DB command is allowed.

### 7.6 Refactor check

- No Campaign participant or eligibility code exists.
- No claimability state is persisted.
- Config route inputs are not financial authority.
- Product status and root financial status remain separate.
- Campaign creation never requires or fabricates a Poll reward row.
- Missing pre-cutover vault readiness is reported conservatively.
- No existing Poll response shape changed.

## 8. Slice V2C.2E - Atomic Financial Authority and Vault Cutover

**Commit:** `feat(v2c2): switch financial authority to settlements`

**Review stop:** This is the only authority-switch slice. After the guarded
cutover, vault decrypt/signing, Poll compatibility, and focused financial DB
gates pass, stop for review before the final full-foundation gate.

### 8.1 Files

Add:

- `supabase/migrations/20260913085000_v2c2_financial_root_cutover.sql`;
- `supabase/migrations/20260913086000_v2c2_poll_read_root_cutover.sql`;
- `src/lib/rewards/financial-authority-cutover.db.test.ts`.

Modify:

- `src/lib/rewards/settlement-root.ts`;
- `src/lib/rewards/settlement.ts`;
- `src/lib/rewards/reservation-service.ts`;
- `src/lib/rewards/funding.ts`;
- `src/lib/rewards/funding-confirmation.ts`;
- `src/lib/rewards/payout.ts`;
- `src/lib/rewards/payout-reconciliation.ts`;
- `src/lib/rewards/refund.ts`;
- `src/lib/rewards/refund-reconciliation.ts`;
- `src/lib/rewards/poll-participation-adapter.ts`;
- `src/lib/rewards/poll-closure-adapter.ts`;
- `src/lib/rewards/vault-key.ts`;
- `src/lib/rewards/vault-service.ts`;
- `src/lib/rewards/vault-signing.ts`;
- `src/app/api/polls/publish/route.ts`;
- `src/app/api/polls/[pollId]/reward/config/route.ts`;
- `src/app/api/polls/[pollId]/reward/funding/intents/route.ts`;
- `src/app/api/polls/[pollId]/reward/funding/intents/[intentId]/bind/route.ts`;
- `src/app/api/polls/[pollId]/reward/funding/intents/[intentId]/confirm/route.ts`;
- `src/app/api/polls/[pollId]/reward/payouts/[attemptId]/reconcile/route.ts`;
- `src/app/api/polls/[pollId]/reward/refund/route.ts`;
- `src/app/api/polls/[pollId]/reward/refund/[refundId]/reconcile/route.ts`;
- `src/app/api/me/polls/route.ts`;
- `src/lib/data/public-polls.ts`;
- `src/lib/data/explore-queries.ts`;
- existing focused route, service, vault, and DB tests.

Update only through local generation:

- `src/types/database.ts`.

### 8.1.1 Symbols and callers

The implementation must audit and update these symbols rather than performing a
partial string rename:

- `resolvePollRewardSettlement` and `loadRewardSettlementContext` in
  `settlement-root.ts`;
- `createRewardSettlementService`, `beginFunding`, `bindFunding`,
  `confirmFunding`, `executePayout`, and `reconcilePayout` in `settlement.ts`;
- `createSupabaseRewardReservationStore` and `reserveAtomic` in
  `reservation-service.ts`;
- `loadFundingConfirmationContext`,
  `createDefaultFundingConfirmationDependencies`, and
  `reconcileFundingIntent` in `funding-confirmation.ts`;
- `executeReservedRewardPayout`, its payout store loaders, and vault lock
  callbacks in `payout.ts`;
- `loadPayoutReconciliationContext`, `reconcilePayoutAttempt`, and payout lock
  dependencies in `payout-reconciliation.ts`;
- `loadRefundReconciliationContext`, `reconcileRefund`, and refund lock
  dependencies in `refund-reconciliation.ts`;
- `executeRewardRefund` and refund signing callbacks in `refund.ts`;
- `ensureCampaignVault`, `getCampaignVault`, and `withCampaignVaultKey` in
  `vault-service.ts`, renamed or replaced by settlement-rooted equivalents;
- `VaultAadContext`, `buildVaultAad`, `encryptVaultKey`, and `decryptVaultKey` in
  `vault-key.ts`;
- `PollRewardParticipationAdapter` and `PollRewardClosureAdapter` resolvers;
- Poll publication/configuration/read callers listed in Section 8.1.

### 8.2 SQL RPC cutover inventory

Update the authoritative reads/writes of these existing RPCs in
`20260913085000_v2c2_financial_root_cutover.sql`:

- `begin_reward_funding_atomic`;
- `bind_reward_funding_transaction_atomic`;
- `confirm_reward_funding_atomic`;
- `claim_reward_receipt_atomic` for the existing Poll path;
- `begin_reward_payout_atomic`;
- `prepare_reward_payout_atomic`;
- `retry_reward_payout_atomic`;
- `acquire_reward_payout_vault_lock_atomic`;
- `confirm_reward_payout_atomic`;
- `mark_reward_payout_broadcast_starting`;
- `mark_reward_payout_broadcast_atomic`;
- `record_reward_payout_failure_atomic`;
- `record_reward_payout_unknown_atomic`;
- `release_reward_payout_vault_lock_atomic`;
- `begin_reward_refund_atomic`;
- `prepare_reward_refund_transaction_atomic`;
- `confirm_reward_refund_atomic`;
- `acquire_reward_refund_vault_lock_atomic`;
- `mark_reward_refund_broadcast_starting_atomic`;
- `mark_reward_refund_broadcast_atomic`;
- `record_reward_refund_failure_atomic`;
- `record_reward_refund_unknown_atomic`;
- the vault ensure function, replaced at authority level by
  `ensure_reward_settlement_vault_atomic(_settlement_id, ...)`;

Keep shipped function names and `_campaign_id` compatibility arguments only
where required by existing callers. Inside every function, interpret that value
as a settlement ID, lock/load `reward_settlements`, and use settlement-rooted
child fields. Do not leave a mutable path that reads terms, balances, status,
vault, or accounting from `reward_campaigns`.

The reservation RPC must continue to validate the Poll source and committed vote,
but lock the settlement root, derive amount/capacity/status from that root, and
insert a receipt with settlement reference plus stable Poll compatibility fields.
Payout attempts remain reached through the receipt.

Funding, payout, refund, lease, retry, hash, and finality safety rules remain
unchanged. Each confirmation must still use exact observed amount, recipient,
sender, network, transaction hash, canonical inclusion, and macro finality.

### 8.3 Vault constraint and RPC transition

In the same guarded migration, immediately after Phase C resync:

1. Revalidate every vault has a settlement ID, exactly one vault per settlement,
   and the expected Poll binding where `campaign_id` is non-null.
2. Reject any envelope/address mutation by comparing before and after values.
3. Drop the vault `campaign_id` primary-key/`NOT NULL` role.
4. Make `settlement_id` `NOT NULL` and the primary key.
5. Retain `campaign_id` as a nullable FK to `reward_campaigns`.
6. Add the partial unique index on non-null `campaign_id`.
7. Add the consistency guard rejecting a Poll campaign whose binding does not
   name the same settlement.
8. Replace the active vault RPC with
   `ensure_reward_settlement_vault_atomic(_settlement_id, _vault_address_hex,
   _envelope_version, _encryption_algorithm, _ciphertext, _iv, _auth_tag)`.
9. Derive the Poll compatibility campaign ID from the binding inside the RPC;
   standalone Campaign inserts use null `campaign_id`.
10. Keep the RPC service-role-only and reject any non-root state or malformed
    envelope.

The generic vault service must use settlement ID for row lookup, root state,
signing, address validation, and AAD context. It must never accept a client
campaign ID, vault address, envelope field, ciphertext, or key material.

In `vault-key.ts`, rename the conceptual `VaultAadContext.campaignId` field to
`settlementId` only if all callers and tests are updated together. The resulting
`buildVaultAad` bytes must remain exactly:

```text
votum:reward-vault:v1\0<existing-UUID-text>\0<lowercase-vault-address>
```

Existing Poll ciphertext must decrypt without re-encryption.

### 8.4 Application cutover

Update `settlement-root.ts` to load root authority and resolve both paths:

```text
Poll:
  pollId -> reward_campaigns -> settlement_source_bindings -> settlementId

Campaign:
  participation_campaigns -> settlement_source_bindings -> settlementId
```

Update `settlement.ts`, reservation, funding, payout, reconciliation, closure,
refund, and signing loaders so all financial context is loaded by settlement ID.
Every child query must verify its settlement reference and reject cross-root
access. The Poll adapter remains the only owner of Poll public/rewarded/free/
legacy/creator eligibility rules.

Update Poll publication and reward configuration so new Poll reward offers create
or update a root, Poll adapter row, and binding atomically. Preserve the outward
`campaignId`, `state`, and vault aliases. Existing Poll reward IDs remain stable.

Update `get_public_reward_campaign(_poll_id)` in the read-cutover migration to
resolve through Poll adapter/binding/root and return the existing allowlisted
fields. Keep anonymous/authenticated access limited to the safe public function;
never expose root balances or vault material.

Update `public-polls.ts` and `explore-queries.ts` only as needed for the same
allowlisted response parser. Do not add public Campaign discovery.

### 8.5 RED

Write cutover tests that fail against the campaign-rooted implementation:

- Phase C resync reads current campaign authority and not stale root snapshots;
- all root/child amounts, counters, states, leases, and accounting agree at
  switch;
- after switch, changing an old campaign financial field cannot affect a funding,
  reservation, payout, reconciliation, refund, or vault operation;
- all listed RPCs use root fields as the only mutable authority;
- old campaign financial columns are not refreshed or dual-written;
- Poll binding resolves the correct root and never treats Poll ID as root ID;
- an existing Poll vault has equal settlement/campaign UUIDs and unchanged
  address/envelope values;
- every existing Poll vault decrypts with the original AAD bytes;
- Poll payout and refund signing use the same vault address/key;
- standalone Campaign settlement can ensure, load, decrypt, and sign through a
  vault with `campaign_id IS NULL` and no `reward_campaigns` row;
- duplicate settlement vaults, mismatched Poll campaign/settlement rows, and
  cross-settlement loads fail closed;
- legacy `vault_wallet`/`vault_key_ref` fields cannot authorize or locate a vault;
- funding intent `vault_wallet` must equal the settlement vault address;
- existing funding/payout/refund IDs, hashes, Poll responses, and automatic vote
  payout behavior remain unchanged;
- signed bytes are persisted before broadcast, broadcast markers prevent blind
  resend, and only bounded hashless pre-broadcast failure is retryable;
- finality and exact transfer checks remain required;
- no Campaign claim or participant payout path was enabled.

### 8.6 GREEN

Implement the migration and service changes as one reviewed authority transition.
Keep irreversible financial boundaries intact:

- service-role RPC locks and reloads root/child authority;
- funding uses designated funder policy from the root;
- reservation uses server-resolved Poll participation and root capacity;
- payout uses receipt amount, root vault, lease, signed bytes/hash, broadcast
  marker, and finality evidence;
- refund uses immutable root refund policy, accounting, lease, signed bytes/hash,
  broadcast marker, and finality evidence;
- vault key bytes exist only inside `withRewardSettlementVaultKey` callbacks.

No route accepts a client settlement ID as a trusted authority. A route may use
its path Poll/Campaign ID only to resolve a server-side binding, then pass the
resolved settlement ID into a service.

### 8.7 Verification

```text
npm test -- src/lib/rewards/settlement.test.ts src/lib/rewards/reservation-service.test.ts src/lib/rewards/closure.test.ts src/lib/rewards/v2c1-compatibility.test.ts
npm test -- src/lib/rewards/vault-key.test.ts src/lib/rewards/vault-service.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/rewards/financial-authority-cutover.db.test.ts src/lib/rewards/reservation.db.test.ts src/lib/rewards/funding-confirmation.db.test.ts src/lib/rewards/payout.db.test.ts src/lib/rewards/refund-preparation.db.test.ts src/lib/rewards/refund-reconciliation.db.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/rewards/vault-settlement-compatibility.db.test.ts
npx supabase migration up
npx supabase gen types typescript --local > src/types/database.ts
npx tsc --noEmit
npm run lint
```

Run local DB tests only after confirming `assertLocalSupabaseForTests()` accepts
the local URL. Do not send any transaction or use a hosted database.

### 8.8 Refactor check

- There is one mutable financial authority: `reward_settlements`.
- There is one custody table: `reward_campaign_vaults`, rooted by settlement.
- Poll IDs enter shared services only through Poll resolution.
- `campaign_id` on a vault is nullable Poll compatibility data, not identity.
- Existing Poll ciphertext and AAD are unchanged and decryptable.
- Standalone Campaign vaults do not require a Poll reward row.
- Old campaign financial fields are frozen, not dual-written.
- Public Poll route shapes and automatic payout behavior are unchanged.
- No client economics, private material, or claim data crosses a service boundary.

## 9. Slice V2C.2F - Full Foundation and Migration Gate

**Commit:** `test(v2c2): verify Campaign foundation and root cutover`

**Review stop:** This is the final V2C.2 implementation gate. Do not begin
V2C.3 until this commit and the full local sequence pass.

### 9.1 Files

Add:

- `src/lib/campaigns/v2c2-foundation.test.ts`.

Update only for proven assertion gaps:

- `src/lib/rewards/vault-settlement-compatibility.db.test.ts`;
- `src/lib/rewards/financial-authority-cutover.db.test.ts`;
- `src/lib/rewards/v2c1-compatibility.test.ts`;
- focused schema, migration, Poll route, or configuration tests.

Do not add UI, claim routes, strategy fixtures, discovery, or NIM integration.

### 9.2 RED and static review

The final tests and source review must prove:

- only the seven ordered V2C.2 migrations add the specified foundation;
- root, Campaign, binding, and additive child constraints match the design;
- no future claim/strategy storage exists;
- no `claimable` product state exists;
- `reward_campaigns.poll_id` remains `NOT NULL UNIQUE`;
- there is no second receipt, payout, refund, or vault ledger;
- no old/new financial dual-write remains after cutover;
- root/backfill/canonical-wallet/child coverage is 100 percent;
- every Poll vault maps `settlement_id = campaign_id` before cutover;
- Poll vault address, ciphertext, IV, tag, envelope metadata, and AAD remain
  unchanged and decrypt after cutover;
- a standalone Campaign settlement owns exactly one vault with null
  `campaign_id` and no `reward_campaigns` row;
- mismatched, duplicate, or cross-settlement vault access fails closed;
- public/authenticated roles cannot read private tables or vault material;
- no private key material enters root or Campaign product rows;
- Poll publication, discovery, voting, receipts, reads, automatic payout, and
  response aliases remain compatible;
- free and legacy Polls never create reward obligations;
- creator votes never create reward receipts;
- reservation/payout follow-up failure does not invalidate a committed vote;
- funding remains designated-wallet authorized and finality-gated;
- payout/refund hash safety, leases, retries, accounting, and finality remain;
- no Campaign claim or participant payout was enabled.

Run these source inspections and classify every match:

```text
rg "option_id|selectedOptionId|selected-option|winner|majority" src/lib/rewards src/app/api/polls
rg "participation_campaigns|CampaignClaim|campaign_claim|Secret Drop|Private Drop|Event Drop|Community Reward" src supabase
rg "RewardParticipationContext|RewardClosureContext|RewardSettlementContext" src
```

Selected-option matches must be Poll-specific. Campaign/claim matches must be
types, schema names explicitly approved for V2C.2, or deferred documentation;
there must be no executable participant path.

### 9.3 GREEN gate

Run the complete established local-only sequence in this order:

```text
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism
npm run lint
npx tsc --noEmit
npm run build
npx tsx src/lib/api/v2b2-schema-test.ts
npx tsx src/lib/api/v2b2-config-test.ts
npx tsx src/lib/api/v2b2-funding-test.ts
npx tsx src/lib/api/v2b2-vault-test.ts
npx tsx src/lib/api/v2b1-backward-test.ts
npx tsx src/lib/api/publish-test.ts
```

The local DB gate must use `assertLocalSupabaseForTests()`. If local Supabase is
unavailable, record the skipped commands and reason. Never substitute a hosted
target. Stop local Supabase after the DB commands complete.

### 9.4 Refactor check

- Review every changed RPC and service for root-only mutable authority.
- Review every new server module for `import "server-only"` where required.
- Review all route bodies for client economics or client identity authority.
- Review all vault callers for settlement ID and unchanged AAD bytes.
- Review all public serializers for safe allowlisted fields only.
- Confirm no protected worktree file is modified or staged.
- Confirm generated types came from the local resulting schema.
- Confirm no unrelated file entered the slice commit.

## 10. Regression and Acceptance Matrix

### 10.1 Schema and identity

- Root, Campaign, and binding constraints match the design.
- New root/Campaign wallet fields are lowercase 40-hex.
- Historical wallet preflight reports invalid values and collisions without
  rewriting source rows.
- Every Poll reward campaign has one stable root and one Poll binding.
- Every Campaign has one root and one Campaign binding.
- No root has two source adapters.
- Poll source identity and settlement identity cannot be confused.

### 10.2 Child and vault migration

- Funding, receipt, refund, and vault settlement coverage is complete before
  authority cutover.
- Old campaign IDs and compatibility columns remain stable.
- Payout attempts remain reached through receipts.
- Hash uniqueness remains cross-ledger safe.
- Every existing Poll vault decrypts after cutover with original AAD bytes.
- Existing Poll vault addresses and envelope values do not change.
- Payout/refund signing continues using the same Poll vault key/address.
- Standalone Campaign vaults work with null compatibility campaign ID.
- No settlement owns two vaults and no cross-root vault load succeeds.
- Public and authenticated roles cannot read vault material.

### 10.3 Authority cutover

- Phase A snapshots are not authoritative.
- Phase B proves complete coverage and invariants.
- Phase C resyncs under the write-maintenance gate.
- Phase D switches RPC/service/readers atomically.
- Phase E freezes old campaign financial fields and removes dual-write behavior.
- Poll public reads resolve through adapter/binding/root.
- No request can observe mixed mutable authority.

### 10.4 Poll behavior

- Publication and reward configuration preserve response aliases.
- Public Poll discovery preserves safe reward output.
- Voting response remains successful after reward follow-up failure.
- Rewarded `reward_first` Polls retain automatic reservation and payout.
- Free and legacy Polls remain reward-ineligible.
- Creator votes remain valid votes but do not create receipts.
- Replay, capacity exhaustion, payout retry, refund, and finality behavior remain.
- Selected option data never enters shared financial records or proof.

### 10.5 Campaign scope

- Creator can create/edit only the supported product configuration boundary.
- Root economics are derived in integer Luna.
- Funding readiness never moves NIM or creates a funding intent.
- No Campaign participant route or claim adapter exists.
- No strategy-specific storage exists.
- Unsupported types cannot be presented as claimable.
- No Campaign discovery, UI, management/refund UI, or physical QA exists.

## 11. Delivery and Commit Order

Implementation commits must be exactly:

1. `feat(v2c2): add settlement root and Poll source bindings`
2. `feat(v2c2): add settlement references to financial children`
3. `feat(v2c2): add Campaign product entity and root binding`
4. `feat(v2c2): add Campaign draft and configuration boundary`
5. `feat(v2c2): switch financial authority to settlements`
6. `test(v2c2): verify Campaign foundation and root cutover`

Each commit must contain only its slice files and its generated database type
change, if that slice changes the local schema. The implementation agent must
stop after each commit for review and must not squash these commits.

The current task is documentation-only. After writing and reviewing this plan,
the only delivery commit is:

```text
git diff --check
git status --short
git diff -- docs/superpowers/plans/2026-09-13-v2c2-campaign-foundation-implementation.md
git add docs/superpowers/plans/2026-09-13-v2c2-campaign-foundation-implementation.md
git commit -m "docs(v2c2): plan Campaign foundation implementation"
git push origin feat/v2-participation-record
git status --short
```

Stage only the plan file. Do not stage protected files or unrelated worktree
changes.

## 12. Definition Of Done

- Six independently testable V2C.2A-F slices document exact files, symbols,
  interfaces, migrations, tests, commands, commit messages, and review stops.
- The ordered migrations implement the settlement root, Poll backfill, child
  references, Campaign entity, exact-one bindings, authority cutover, and Poll
  read cutover without destructive reset.
- Root becomes the only mutable financial authority after Phase D.
- Vaults become settlement-rooted without changing existing Poll envelopes,
  addresses, AAD bytes, or key material.
- Campaign product/configuration state remains separate from financial state.
- Poll compatibility and automatic payout behavior remain intact.
- No claims, eligibility strategies, secret/allowlist/event/community storage,
  Campaign participant flow, discovery, UI, NIM transfer, hosted DB operation,
  deployment, or physical QA is included.
- Local-only schema, focused, regression, typecheck, lint, and build gates are
  required before V2C.2 completion.
- The current documentation-only delivery contains only this plan file in its
  commit.
