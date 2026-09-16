# V2C.3 Public Giveaway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first complete Public Giveaway Campaign lifecycle:
creator funding → publish/share → signed participant Claim NIM → atomic
reservation → automatic payout/finality → close → unused-NIM refund.

**Architecture:** Thin Public Giveaway eligibility/authorization adapter over
the existing reward_settlements financial engine. reward_receipts remain the
durable entitlement; no second Campaign payout engine or financial ledger.

**Tech Stack:** Next.js 16.2.12 (App Router, `src/app/`), React 19.2.4,
Tailwind CSS v4 (`src/app/globals.css` via `@theme`), TypeScript 5.9.3 strict
(`@/*` maps to `./src/*`), ESLint 9 flat (`eslint.config.mjs`), Vitest 4.1.11
(jsdom, `src/**/*.test.{ts,tsx}`, 30s timeout, `server-only` stubbed),
Supabase (`@supabase/supabase-js` 2.111, Supabase CLI 2.111, PostgreSQL RLS,
security-definer RPCs), `@nimiq/core` 2.7.2 plus `@nimiq/mini-app-sdk` 0.1.0
for wallet, signing, broadcast, and chain observation, Node 24.15.0. Commands:
`npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism`,
`npm run lint`, `npx tsc --noEmit`, `npm run build`.

**Spec:**
docs/superpowers/specs/2026-09-16-v2c3-public-giveaway-participant-flow-design.md

**Status:** Implementation plan only. This document writes no production code,
creates no migrations, creates no tests, modifies no APIs, touches no
Supabase instance, starts no V2C.3A work, sends no NIM, deploys nothing, and
merges nothing.

---

## Global Constraints

The following invariants from the approved spec are non-negotiable across
every task. Any task that conflicts with one of them is wrong and must stop.

1. `reward_settlements` is the sole mutable financial authority.
2. `settlement_id` is the vault runtime and financial authority;
   `reward_campaign_vaults.settlement_id` is the only vault lookup identity.
3. Poll behavior remains backward compatible in every slice.
4. `reward_receipts` remain the preferred durable entitlement.
5. No second Campaign financial ledger is created.
6. No Campaign-specific payout or reconciliation engine is created.
7. Participation requires an explicit Claim NIM action; page views, wallet
   connects, and session creation never reserve.
8. First entitlement creation requires a claim-specific wallet signature over
   a server-created challenge; a base wallet session alone never authorizes
   creation.
9. One Campaign plus one canonical wallet equals one entitlement; duplicates
   return the existing receipt.
10. The creator cannot claim their own Campaign.
11. Entitlement is reservation-first: a committed reservation belongs to the
    wallet even while payout is pending.
12. Existing reservations survive close and expiry.
13. No participant retry-send button exists anywhere in UI or API.
14. Published, funded, and claimable have disjoint meanings and are never
    conflated in code, copy, or derived state names.
15. No stored authoritative `claimable` flag is created on any table.
16. Exact remaining count is derived from authoritative settlement state on
    every read.
17. Public claimant wallet lists are forbidden in every read model, page, and
    API response.
18. Share-link first; Explore and discovery stay out of scope.
19. Funding and publishing are independent prerequisites; claiming requires
    both.
20. Scheduled starts are supported through the `now >= starts_at` predicate;
    no flag-flip job is created.
21. Early close stops only NEW claims.
22. Refund is blocked while any unresolved obligation exists.
23. Claim-challenge consumption and reservation commit in one authoritative
    transaction; independent commits are forbidden.
24. Challenges are issued server-side with an approximate 5-minute expiry.
25. Claim eligibility is re-evaluated from locked rows at reservation time;
    adapter pre-checks never substitute for the in-transaction re-check.
26. No Secret Drop, Private Drop, Event Drop, or Community Reward strategy is
    implemented.
27. No generalized eligibility framework spanning Campaign types is created.
28. One shared funding engine serves Poll and Campaign: the funding RPCs
    `begin_reward_funding_atomic`, `bind_reward_funding_transaction_atomic`,
    and `confirm_reward_funding_atomic` use canonical `_settlement_id`
    identity after the D1 cutover, with no product-specific fork, legacy
    overload, or compatibility wrapper.
29. Shared financial RPCs emit source-neutral errors only; Poll and Campaign
    compatibility wording is translated at the adapter and service
    boundaries, never inside the engine.
30. No real NIM moves during implementation until the separately approved
    physical QA in the final section of this plan, which itself requires
    explicit human approval before execution.

---

## Local Database Policy

`supabase_db_votum` is a FROZEN legacy development database. It holds stale
migration ledger entries and is NOT a migration acceptance target for V2C.3.

- All V2C.3 database work runs against disposable clean-room Supabase
  environments built from current repository source
  (`supabase migration up` from `supabase/migrations/` on a fresh project).
- Reuse the existing clean-room plumbing: `VOTUM_CLEANROOM_SUPABASE_URL`,
  `VOTUM_CLEANROOM_SUPABASE_KEY`, `VOTUM_CLEANROOM_DB_CONTAINER` resolved by
  `src/lib/rewards/test-target.ts` (`testSupabaseUrl`, `testSupabaseKey`,
  `testDbContainer`), guarded by `assertLocalSupabaseForTests()` from
  `src/lib/rewards/test-env.ts`, with `docker exec <container> psql`
  cleanup following the pattern in
  `src/lib/rewards/reservation.db.test.ts` and
  `src/lib/rewards/public-campaign.db.test.ts`.
- Never plan a reset of the frozen database, a migration repair, a ledger
  edit, a fake registration, or a restoration of stale migrations.
- Every migration task specifies a clean-room test plus a db-reset path test
  (fresh `supabase migration up` from zero, then assertion of the new
  objects).

---

## Repository Map (Verified Against Current Source)

The plan names only objects that exist at commit `1049ce9`
(`docs(v2c3): design Public Giveaway participant flow`).

### Tables

- `participation_campaigns` (`id`, `settlement_id UNIQUE NOT NULL`,
  `owner_wallet`, `campaign_type`, `visibility`, `title`, `description`,
  `status` in draft/published/closed/expired/cancelled, `starts_at`,
  `ends_at`, version and timestamp markers). RLS on, service-role only.
- `reward_settlements` (sole mutable financial authority; `status` in
  configured/funding_pending/funded/rewarding/exhausted/closed/refunding/
  refunded/cancelled; counters, balances, `first_reservation_at`, payout
  lease). RLS on, service-role only.
- `settlement_source_bindings` (`settlement_id` PK, `source_type` in
  poll_reward_campaign/participation_campaign, exactly-one-source check).
- `reward_receipts` (`campaign_id NOT NULL` FK `reward_campaigns`,
  `poll_id NOT NULL` FK `polls`, `settlement_id NOT NULL` FK
  `reward_settlements`, `UNIQUE (campaign_id, participant_wallet)`).
  Slice D adapts the Poll-shaped `NOT NULL` columns; see Migration
  M2 justification below. Slices A–C never touch this table.
- `reward_funding_transactions` (`campaign_id NOT NULL` FK
  `reward_campaigns`, `settlement_id NOT NULL`). Same adaptation need; M2
  in slice D, which additionally proves Campaign-branch funding execution
  as the first consumer of the migrated columns.
- `reward_refunds` (`campaign_id NOT NULL` FK `reward_campaigns`,
  `settlement_id NOT NULL`). Same adaptation need; M2 in slice D alongside
  the receipt columns.
- `reward_campaign_vaults` (PK `settlement_id`, nullable `campaign_id`
  compatibility FK; standalone Campaign rows use `campaign_id IS NULL`).
- `reward_payout_attempts` (reached through `receipt_id`; no direct source
  column; no change planned).
- `wallet_challenges` (`wallet_address`, `message`, `origin`, `expires_at`,
  `used_at`) and `wallet_sessions` (`token_hash`, `wallet_address`,
  `expires_at`, `revoked_at`).
- `polls`, `poll_votes`, `poll_options`, `reward_campaigns`
  (`poll_id NOT NULL UNIQUE`; untouched by V2C.3).

### Atomic RPCs (Post-V2C.2E Cutover, Settlement-Authoritative)

`begin_reward_funding_atomic`, `bind_reward_funding_transaction_atomic`,
`confirm_reward_funding_atomic`, `claim_reward_receipt_atomic(
_participation_id uuid, _campaign_id uuid)` (Poll-bound: locks
`reward_settlements`, joins the Poll binding branch, checks
`poll_votes`/`polls`, replays on existing receipt by
`(settlement_id, lower(trim(participant_wallet)))`, inserts with
`ON CONFLICT (campaign_id, participant_wallet) DO NOTHING`),
`begin_reward_payout_atomic`, `prepare_reward_payout_atomic`,
`retry_reward_payout_atomic`,
`acquire_reward_payout_vault_lock_atomic`,
`release_reward_payout_vault_lock_atomic`, `confirm_reward_payout_atomic`,
`begin_reward_refund_atomic(_campaign_id uuid, _session_token_hash text)`
(Poll-bound), `prepare_reward_refund_transaction_atomic`,
`acquire_reward_refund_vault_lock_atomic`,
`mark_reward_refund_broadcast_starting_atomic`,
`mark_reward_refund_broadcast_atomic`, `record_reward_refund_failure_atomic`,
`record_reward_refund_unknown_atomic`,
`ensure_reward_settlement_vault_atomic`, `ensure_poll_reward_settlement_atomic`,
`publish_participation_campaign_atomic`,
`update_participation_campaign_draft_atomic`, `cast_poll_vote_atomic`,
`get_public_poll_results`, `get_public_reward_campaign`. All financial RPCs
revoke `PUBLIC, anon, authenticated` and grant `service_role` only.

### Server Libraries

- `src/lib/rewards/participation.ts`: `RewardParticipationSourceType`
  (`poll_vote | campaign_claim`), `RewardParticipationContext`,
  `RewardParticipationAdapter`, `RewardReservationResult`,
  `RewardSettlementContext`, `RewardClosureTrigger`, `RewardClosureContext`,
  `parseRewardParticipationContext` (exact-keys shape check plus
  source/evidence/binding parity).
- `src/lib/rewards/poll-participation-adapter.ts`:
  `createPollRewardParticipationAdapter`,
  `createSupabasePollRewardParticipationStore`.
- `src/lib/rewards/reservation-service.ts`:
  `createRewardReservationService`, `createSupabaseRewardReservationStore`
  (calls `claim_reward_receipt_atomic`; `hasPollEvidence` gate currently
  accepts only `poll_vote`).
- `src/lib/rewards/settlement.ts`: `RewardSettlementService`
  (`beginFunding`, `bindFunding`, `confirmFunding`, `executePayout`,
  `reconcilePayout`), `resolvePollRewardSettlement`,
  `loadRewardSettlementContext`.
- `src/lib/rewards/settlement-root.ts`: `resolvePollRewardSettlement`,
  `loadRewardSettlementContext` (settlement-root loader reused by V2C.3).
- `src/lib/rewards/closure.ts` plus `src/lib/rewards/poll-closure-adapter.ts`
  (Poll close-trigger mapping pattern V2C.3F mirrors).
- `src/lib/rewards/funding.ts` (`mapFundingIntentResult`,
  `FundingIntentResponse`), `src/lib/rewards/funding-confirmation.ts`,
  `src/lib/rewards/payout.ts` (`executeReservedRewardPayout`),
  `src/lib/rewards/payout-reconciliation.ts`, `src/lib/rewards/refund.ts`,
  `src/lib/rewards/refund-reconciliation.ts`,
  `src/lib/rewards/refund-policy.ts` (pure obligation/accounting policy),
  `src/lib/rewards/reconciliation.ts`,
  `src/lib/rewards/vault-service.ts` (`ensureRewardSettlementVault`,
  `getRewardSettlementVault`, `withRewardSettlementVaultKey`,
  `SettlementVaultPublic`), `src/lib/rewards/vault-signing.ts`,
  `src/lib/rewards/vault-key.ts`, `src/lib/nimiq/observation.ts`
  (`createNimiqTransactionObservationAdapter`),
  `src/lib/nimiq/broadcast.ts`, `src/lib/nimiq/server-crypto.ts`
  (`normalizeAddress`, `addressesEqual`, `deriveAddressFromPublicKey`,
  `verifyNimiqMiniAppSignature`, `toUserFriendlyAddress`),
  `src/lib/api/session.ts` (`getVerifiedWalletSession`, `hashToken`),
  `src/lib/api/origin.ts` (`isSameOriginRequest`, `getServerOrigin`).
- `src/lib/campaigns/configuration.ts`:
  `createParticipationCampaign`, `updateParticipationCampaignDraft`,
  `publishParticipationCampaign`, `loadCampaignFundingReadiness`,
  `toCampaignConfigurationReadModel`,
  `campaignConfigurationErrorDetails`,
  `campaignInputHasAuthorityFields`; `src/lib/campaigns/types.ts`
  (`ParticipationCampaignType`, `CampaignConfiguration`,
  `CampaignConfigurationReadModel`).

### Routes and Surfaces

- `POST /api/campaigns`, `PATCH /api/campaigns/[campaignId]`,
  `POST /api/campaigns/[campaignId]/publish`,
  `GET /api/campaigns/[campaignId]/funding-readiness` (owner session).
- `POST /api/polls/[pollId]/vote` (vote-first, then
  `PollRewardParticipationAdapter` → `RewardReservationService` →
  `executePayout`; valid votes survive reward follow-up failure).
- Poll funding: `POST /api/polls/[pollId]/reward/funding/intents`,
  `POST .../intents/[intentId]/bind`, `POST .../intents/[intentId]/confirm`;
  payout reconcile and refund routes under
  `/api/polls/[pollId]/reward/...` (patterns V2C.3A mirrors for campaigns).
- Wallet proof: `POST /api/wallet-proof/challenge` (5-minute TTL message
  `Votum wallet verification / Domain / Address / Nonce / Issued at /
  Expires at`, old unused challenges marked used),
  `POST /api/wallet-proof/verify` (expiry, single-use, canonical address,
  public-key-derived address, `verifyNimiqMiniAppSignature`),
  `GET /api/wallet-proof/session`, logout route.
- Public reads: `GET /api/polls/[pollId]/results` via
  `get_public_poll_results`; page `src/app/polls/[pollId]/page.tsx` with
  `getPublicPollById` from `src/lib/data/public-polls.ts`.
- Client: `src/providers/NimiqProvider.tsx` (`initializeNimiqProvider`,
  `requestAccounts`, `isInsideNimiqPay`),
  `src/providers/VotumSessionProvider.tsx` (challenge → `signMessage` from
  `src/lib/nimiq/client.ts` → verify flow), `src/components/poll/*`
  (`PollVotingPanel`, `PollVotePanel`, `PollResultPanel`),
  `src/components/ui/WalletButton.tsx` (UI-only placeholder per AGENTS.md).

### Test Plumbing

Colocated `src/**/*.test.ts` unit suites plus `*.db.test.ts` clean-room
suites using `test-target.ts`/`test-env.ts` and `docker exec` psql cleanup;
`src/lib/rewards/settlement-fixture.ts` (`attachPollSettlement`);
`src/lib/api/*-test.ts` HTTP scripts (`v2b2-funding-test.ts`,
`v2b2-config-test.ts`, `vote-test.ts`, `v2b1-backward-test.ts`); route-local
`route.test.ts` files.

---

## Migration Plan (Exact Numbering)

Highest shipped migration is `20260913086000_v2c2_poll_read_root_cutover.sql`.
No `20260916*` migration is committed, so the sequence below is
collision-free. Historical migrations are never edited. Migration versions
are monotonic in slice execution order (C, then D, then F); slice A ships
no migration. New migrations:

- **M1 `20260916000000_v2c3_claim_challenges.sql`** (Task C1):
  `campaign_claim_challenges` private table, indexes, RLS, grants.
- **M2 `20260916001000_v2c3_campaign_source_columns.sql`** (Task D1,
  Phase 1): adapts `reward_funding_transactions.campaign_id`,
  `reward_receipts.campaign_id`, `reward_receipts.poll_id`, and
  `reward_refunds.campaign_id` from `NOT NULL` to nullable with
  exactly-one-source check constraints and settlement-scoped uniqueness,
  AND cuts the three shared funding RPCs to the settlement-canonical
  contract: drops and recreates `begin_reward_funding_atomic`,
  `bind_reward_funding_transaction_atomic`, and
  `confirm_reward_funding_atomic` with the same names and argument TYPE
  signatures under the new `_settlement_id` first-argument name, generic
  settlement-to-binding source resolution for both the Poll and Campaign
  branches, settlement-derived economics, Campaign funding rows written
  with `campaign_id IS NULL`, and identical `SECURITY DEFINER`,
  `search_path`, volatility, grants, and ownership. No legacy overload,
  compatibility wrapper, or second Poll-shaped contract survives, and no
  `begin/bind/confirm_campaign_funding_atomic` fork is created.
  Justification recorded in Task D1: the spec default (reuse
  `reward_receipts`, no second table) is literally impossible against the
  shipped Poll-shaped `NOT NULL` FKs, because a standalone Campaign row must
  never fabricate a `reward_campaigns` row or a `polls` row. The adaptation
  keeps one ledger and adds a Campaign branch to it; it does not create a
  parallel table. The migration and the atomic reservation behavior that
  consumes it ship in the same reviewed slice D.
- **M3 `20260916002000_v2c3_campaign_claim_rpc.sql`** (Task D1,
  Phase 2): `claim_campaign_reward_atomic` security-definer RPC plus
  grants. Phase 2 starts only after Phase 1 is GREEN.
- **M4 `20260916003000_v2c3_campaign_close_refund.sql`** (Task F2):
  `begin_campaign_refund_atomic` security-definer RPC plus grants.

After each migration file lands, regenerate `src/types/database.ts` with the
project-standard Supabase type generation and include the regenerated file in
the same slice commit.

---

## V2C.3A — Public Giveaway Funding / Readiness

Goal: the Campaign settlement becomes fundable from the creator product flow
through the existing settlement vault and funding engine. Slice A ships no
migration, modifies no `reward_receipts` schema, and supports no participant
entitlement: no Campaign receipts, no claim reservations, no claim APIs, no
claim authorization, and no payout claims. Campaign-branch funding-row
execution is first proven GREEN in Task D1 Phase 1 as the initial consumer
of the slice-D source migration; slice A proves vault usage, authoritative
terms, route contracts, delegation to the settlement engine, and readiness.

### Task A1 — Standalone Campaign settlement vault provisioning proof

- [ ] Prove `ensureRewardSettlementVault` provisions exactly one vault with
  `campaign_id IS NULL` for a `participation_campaign` settlement, reusing
  the existing envelope contract.

**Files**

- Create: `src/lib/campaigns/campaign-vault.db.test.ts`
- Modify: none (`src/lib/rewards/vault-service.ts` is reused unchanged;
  record any gap found as a blocking finding instead of working around it)

**Interfaces**

- Consumes: `ensureRewardSettlementVault(settlementId: string):
  Promise<SettlementVaultPublic>`,
  `getRewardSettlementVault(settlementId: string)` from
  `src/lib/rewards/vault-service.ts`; `createParticipationCampaign` from
  `src/lib/campaigns/configuration.ts`.
- Produces: passing characterization proof that a standalone Campaign
  settlement owns one vault row keyed by `settlement_id` with
  `campaign_id IS NULL`, unchanged AAD bytes, and no `reward_campaigns` row.

**TDD**

- RED: `npx vitest run src/lib/campaigns/campaign-vault.db.test.ts`
  asserting vault creation for a fresh `public_giveaway` settlement; the
  test file does not exist yet so the run fails at collection.
- Implement: only the test file plus a Campaign settlement fixture helper
  inside it; no production change.
- GREEN: the suite passes on the clean-room instance.
- Regression: `npx vitest run src/lib/rewards/vault-service.test.ts src/lib/rewards/vault-settlement-compatibility.db.test.ts`

**Commit:** Fold into slice commit `feat(v2c3a): campaign funding and readiness foundation`.

### Task A2 — Campaign funding service adapter

- [ ] Add the server-only Campaign funding adapter that resolves the Campaign
  branch and delegates every money decision to the existing settlement
  funding engine. Slice A proves terms derivation, authorization, vault
  resolution, and delegation on fixtures that require no schema change;
  Campaign-branch funding-row execution is proven in Task D1 Phase 1 as the
  first consumer of migration M2.

**Files**

- Create: `src/lib/campaigns/funding.ts`
- Create: `src/lib/campaigns/funding.test.ts`
- Create: `src/lib/campaigns/funding.db.test.ts`

**Interfaces**

- Consumes: `resolveCampaignRewardSettlement` (as built in slice A in
  `src/lib/campaigns/settlement.ts`, mirroring
  `resolvePollRewardSettlement` but joining the
  `participation_campaign` binding branch and returning `{ kind: "ok";
  settlementId: string; ownerWallet: string }`; the shared
  `src/lib/rewards/settlement-root.ts` stays Poll-pure per the V2C.1
  compatibility gate),
  `loadRewardSettlementContext` from `src/lib/rewards/settlement.ts`,
  `SettlementVaultPublic` via `getRewardSettlementVault`,
  `createNimiqTransactionObservationAdapter` from
  `src/lib/nimiq/observation.ts`, `normalizeAddress` from
  `src/lib/nimiq/server-crypto.ts`.
- Produces in `src/lib/campaigns/funding.ts`:
  `beginCampaignFunding(admin, campaignId: string, funderWallet: string):
  Promise<SettlementFundingResult>`,
  `bindCampaignFunding(admin, campaignId: string, intentId: string,
  funderWallet: string, transactionHash: string):
  Promise<SettlementBindingResult>`,
  `confirmCampaignFunding(admin, campaignId: string, intentId: string,
  funderWallet: string): Promise<FundingConfirmationResult |
  FundingLoadFailure>`. Each function derives settlement, funder, vault,
  amount, reference, and network server-side, enforces
  `funding_mode = 'creator'` with `funding_wallet = owner_wallet` for V2C.3,
  and calls the existing settlement RPCs with the settlement ID. No
  economics originate from arguments beyond identity.

**TDD**

- RED: `npx vitest run src/lib/campaigns/funding.test.ts` with stubbed
  stores asserting funder enforcement, unknown-Campaign rejection, and
  server-derived amount; the module does not exist so the run fails at
  import.
- Implement: the smallest `src/lib/campaigns/funding.ts` plus the
  `resolveCampaignRewardSettlement` addition that satisfies the unit suite.
- GREEN: `npx vitest run src/lib/campaigns/funding.test.ts`
- Regression (db): `npx vitest run src/lib/campaigns/funding.db.test.ts`
  on the clean-room instance covering, without writing any Campaign
  funding row (no schema change exists in slice A): Campaign-branch
  settlement resolution, authoritative amount derivation, funder
  enforcement, and vault resolution; plus delegation proof of hash replay
  and cross-ledger safety, underpayment and overpayment accounting, and
  the finality requirement through the existing settlement engine on Poll
  fixtures via `attachPollSettlement`; plus
  `npx vitest run src/lib/rewards/funding-confirmation.db.test.ts src/lib/rewards/hash-safety.db.test.ts`.
  Campaign-branch intent to funded execution is proven in Task D1 Phase 1,
  never here.

**Commit:** Fold into slice commit `feat(v2c3a): campaign funding and readiness foundation`.

### Task A3 — Creator Campaign funding routes

- [ ] Expose intent, bind, and confirm funding routes for the Campaign
  branch, mirroring the Poll funding route contracts exactly.

**Files**

- Create: `src/app/api/campaigns/[campaignId]/funding/intents/route.ts`
  (`POST` → `beginCampaignFunding`)
- Create: `src/app/api/campaigns/[campaignId]/funding/intents/[intentId]/bind/route.ts`
  (`POST { transactionHash }` → `bindCampaignFunding`)
- Create: `src/app/api/campaigns/[campaignId]/funding/intents/[intentId]/confirm/route.ts`
  (`POST` → `confirmCampaignFunding`)
- Create: `src/app/api/campaigns/[campaignId]/funding/intents/route.test.ts`
  plus bind and confirm `route.test.ts` files alongside each route

**Interfaces**

- Consumes: `getVerifiedWalletSession` from `src/lib/api/session.ts`,
  `normalizeAddress`, `isSameOriginRequest` from `src/lib/api/origin.ts`,
  the three Task A2 functions, `mapFundingIntentResult` from
  `src/lib/rewards/funding.ts`.
- Produces: `FundingIntentResponse` JSON on intent creation (server-derived
  vault, exact Luna total, reference, deadline), `{ settlementId, intentId,
  transactionHash }` on bind, and the confirmation result on confirm. Error
  codes mirror the Poll funding routes (`session_missing`,
  `service_unavailable`, `campaign_not_found`, `forbidden`,
  `vault_unavailable`, `funding_amount_unsafe`, `campaign_state_conflict`,
  `funding_intent_failed`). No route accepts amount, vault, or network from
  the request body.

**TDD**

- RED: `npx vitest run src/app/api/campaigns/[campaignId]/funding/intents/route.test.ts`
  asserting 401 without session, 403 for a non-owner funder, 404 for an
  unknown Campaign, and contract shapes for intent, bind, and confirm;
  routes do not exist so the run fails at import.
- Implement: the three routes with session, origin, and funder checks
  delegating to Task A2.
- GREEN: the three route suites pass on contract and authorization cases
  that require no Campaign funding-row write. Campaign-branch
  intent to funded execution through these routes is proven in Task D1
  Phase 1, never here.
- Regression: `npx vitest run src/app/api/campaigns/route.test.ts "src/app/api/campaigns/[campaignId]/route.test.ts" "src/app/api/campaigns/[campaignId]/funding-readiness/route.test.ts" src/lib/rewards/funding-confirmation.test.ts`

**Commit:** Fold into slice commit `feat(v2c3a): campaign funding and readiness foundation`.

### Task A4 — Funding-readiness read and creator response model

- [ ] Extend the creator readiness read so it reports settlement funding
  truth for Campaign settlements, and prove no claim path exists yet.

**Files**

- Modify: `src/lib/campaigns/configuration.ts`
  (`loadCampaignFundingReadiness` gains settlement-status, funded-amount,
  and reward-ready derivation for the Campaign branch)
- Create: `src/lib/campaigns/funding-readiness.db.test.ts`

**Interfaces**

- Consumes: `loadRewardSettlementContext`,
  `resolveCampaignRewardSettlement`, `getRewardSettlementVault`.
- Produces: extended readiness object `{ campaign, fundingReadiness: {
  ready: boolean; settlementStatus: string; fundedAmountLuna: string;
  requiredAmountLuna: string; vaultReady: boolean } }` served by the
  existing `GET /api/campaigns/[campaignId]/funding-readiness` route. A
  funded draft reports `ready: true` while staying non-claimable; a
  published-but-unfunded Campaign reports `ready: false`.

**TDD**

- RED: `npx vitest run src/lib/campaigns/funding-readiness.db.test.ts`
  asserting funded-draft readiness and published-but-unfunded unreadiness;
  the extended fields are absent so assertions fail.
- Implement: the smallest extension to `loadCampaignFundingReadiness`.
- GREEN: the suite passes on the clean-room instance, including an
  assertion that no receipt, challenge, or claim route exists for the
  Campaign (HTTP 404 probe against `/api/campaigns/[campaignId]/claims`).
- Regression: `npx vitest run src/lib/campaigns/configuration.db.test.ts src/lib/campaigns/v2c2-foundation.test.ts`

**Commit:** `feat(v2c3a): campaign funding and readiness foundation`

### Slice V2C.3A exit gate

- [ ] A configured `public_giveaway` Campaign provisions one
  settlement-rooted vault, derives authoritative funding terms, exposes the
  three funding routes with session, funder, and contract checks proven,
  demonstrates delegation to the settlement funding engine on fixtures that
  require no schema change, and reports readiness that agrees with
  settlement state for funded drafts and published-but-unfunded Campaigns.
  No migration ships. No claim, challenge, receipt, or entitlement path
  exists. Campaign-branch funding-row execution to `funded` is proven in
  Task D1 Phase 1 as the first consumer of migration M2. Poll funding
  suites stay green.

---

## V2C.3B — Public Read + Share-Link Surface

Goal: safe public Campaign page and read model with exact reward
availability. No active Claim NIM action ships in this slice.

### Task B1 — Public Giveaway read projector

- [ ] Add the server-only public projector with the spec allowlist and the
  derived claim-state machine.

**Files**

- Create: `src/lib/campaigns/public-giveaway.ts`
- Create: `src/lib/campaigns/public-giveaway.test.ts`
- Create: `src/lib/campaigns/public-giveaway.db.test.ts`

**Interfaces**

- Consumes: `participation_campaigns` row, bound `reward_settlements` row
  via `resolveCampaignRewardSettlement` plus `loadRewardSettlementContext`,
  `formatNimAmount` from `src/lib/nimiq/units.ts`.
- Produces: `getPublicCampaignGiveaway(admin, campaignId):
  Promise<PublicCampaignGiveaway | null>` where
  `PublicCampaignGiveaway = { campaignId: string; campaignType:
  "public_giveaway"; visibility: "public" | "unlisted"; title: string;
  description: string | null; startsAt: string | null; endsAt: string | null;
  claimState: "needs_funding" | "starts_soon" | "open" | "full" | "ended" |
  "closed" | "unpublished"; published: boolean; fundingReady: boolean;
  rewardPerParticipantNim: string; maxRewardedParticipants: number;
  remainingRewards: number; reservedCount: number; paidCount: number }`.
  `remainingRewards` equals `max_rewarded_participants -
  rewarded_participant_count` from the locked settlement row on every call.
  `deriveClaimState` is exported pure for the page and the E slice. Draft
  and private Campaigns return `null`. No wallet, challenge, receipt,
  vault, lease, signing, or refund field appears in the type.

**TDD**

- RED: `npx vitest run src/lib/campaigns/public-giveaway.test.ts` with
  canned rows covering unpublished, needs-funding, starts-soon, open, full,
  ended, and closed projections; the module does not exist so the run fails
  at import.
- Implement: the projector with the exact allowlist and state machine.
- GREEN: unit suite passes; then
  `npx vitest run src/lib/campaigns/public-giveaway.db.test.ts` passes on
  the clean-room instance proving exact reward and remaining-count reads on
  funded and unfunded Campaigns with zero reservations (no receipt row can
  exist before slice D). Live-reservation count tracking is proven in Task
  D1 Phase 1 and Task D5, never here.
- Regression: `npx vitest run src/lib/data/public-polls.test.ts src/lib/rewards/settlement-root.test.ts`

**Commit:** Fold into slice commit `feat(v2c3b): public campaign read and share-link surface`.

### Task B2 — Public Campaign JSON route

- [ ] Expose the projector over an unauthenticated JSON route with the same
  hardening as the public Poll results route.

**Files**

- Create: `src/app/api/campaigns/[campaignId]/public/route.ts`
  (`GET`, `dynamic = "force-dynamic"`, no session required)
- Create: `src/app/api/campaigns/[campaignId]/public/route.test.ts`

**Interfaces**

- Consumes: `getPublicCampaignGiveaway` from Task B1,
  `createServerClient`/`getConfigStatus` from
  `src/lib/supabase/config.ts` (same pattern as
  `src/app/api/polls/[pollId]/results/route.ts`).
- Produces: `200` with the `PublicCampaignGiveaway` JSON for published
  public/unlisted Campaigns; `404 { error: "not_found" }` for drafts,
  private Campaigns, and unknown IDs. The handler selects the allowlisted
  projection only and never queries challenges, receipts, vaults, leases,
  attempts, or refunds.

**TDD**

- RED: route suite asserting draft → 404, published → 200 with exact
  remaining count, and response-key allowlist equality; the route does not
  exist so the run fails at import.
- Implement: the smallest route delegating to Task B1.
- GREEN: the route suite passes.
- Regression: `npx vitest run src/lib/rewards/public-campaign.db.test.ts`
  plus an RLS probe asserting anon-role direct reads of
  `reward_settlements`, `reward_receipts`, and `reward_campaign_vaults`
  return no rows.

**Commit:** Fold into slice commit `feat(v2c3b): public campaign read and share-link surface`.

### Task B3 — Share-link page

- [ ] Add the server-rendered share-link page with metadata, wired to the
  projector and containing no claim control.

**Files**

- Create: `src/app/campaigns/[campaignId]/page.tsx` (server component,
  `generateMetadata`, `ProductShell` layout, `UnavailableState` on
  not-found per the Poll page pattern)
- Create: `src/components/campaign/CampaignGiveawayView.tsx` (presentational
  only: title, terms, window, derived state, proof strip; disabled Claim NIM
  placeholder button that renders nothing actionable until slice E)

**Interfaces**

- Consumes: `getPublicCampaignGiveaway` (server component calls it with the
  admin client; only the returned DTO crosses into client components),
  `ProductShell` from `src/components/layout/ProductShell`,
  `UnavailableState` from `src/components/state/UnavailableState`.
- Produces: rendered share-link surface following `DESIGN.md` (Soft Fog
  field, Clear Ballot card, Signal Gold single CTA reserved for the future
  Claim action, NIM Blue proof context, text-plus-icon status) and
  `docs/brand-messaging.md` vocabulary. No claimant list, no wallet data, no
  fetch of own-claim state in this slice.

**TDD**

- RED: `npx vitest run src/components/campaign/CampaignGiveawayView.test.tsx`
  rendering open, needs-funding, starts-soon, full, ended, and closed
  fixtures; components do not exist so the run fails at import.
- Implement: the page plus presentational component.
- GREEN: component suite passes; `npm run build` renders the route without
  leaking private fields into the RSC payload (assert by grepping the built
  page data for `participant_wallet`, `nonce`, `ciphertext`).
- Regression: `npx tsc --noEmit` plus existing page build.

**Commit:** Fold into slice commit `feat(v2c3b): public campaign read and share-link surface`.

### Task B4 — Own-claim status read

- [ ] Add the session-scoped own-entitlement read used later by slice E,
  without any creation path.

**Files**

- Create: `src/app/api/campaigns/[campaignId]/claims/mine/route.ts`
  (`GET`, verified session required)
- Create: `src/app/api/campaigns/[campaignId]/claims/mine/route.test.ts`
- Modify: `src/lib/campaigns/public-giveaway.ts` (append
  `getOwnCampaignClaim(admin, campaignId, sessionWallet)` returning the
  caller's receipt-derived status or `{ claimed: false }`)

**Interfaces**

- Consumes: `getVerifiedWalletSession`, `normalizeAddress`,
  `resolveCampaignRewardSettlement`.
- Produces: `{ claimed: true; status: "reserved" | "payout_pending" |
  "paid" | "retryable"; receiptId: string; paidAt: string | null;
  transactionHash: string | null }` scoped strictly to the
  `(settlement_id, session wallet)` tuple, or `{ claimed: false }` which is
  identical whether the Campaign is empty or another wallet claimed. The
  route creates nothing and consumes no challenge.

**TDD**

- RED: route suite asserting 401 without session, `{ claimed: false }` for
  a non-claimant, and cross-wallet opacity (wallet A response reveals
  nothing about wallet B); the route does not exist so the run fails at
  import. No claimant fixture can exist before slice D, so the positive
  exact-own-receipt case is proven in Task E4 after the D backend lands.
- Implement: the read function plus route.
- GREEN: the route suite passes on the clean-room instance.
- Regression: `npx vitest run src/app/api/wallet-proof/session/route.test.ts`

**Commit:** `feat(v2c3b): public campaign read and share-link surface`

### Slice V2C.3B exit gate

- [ ] Draft Campaigns 404, published Campaigns render exact reward and
  remaining count, all six derived states present correctly, no claimant
  list or private material is reachable anonymously or as a non-claimant,
  own-status reads are session-scoped, and Poll read suites stay green. No
  Claim NIM action is wired and no claim storage exists.

---

## V2C.3C — Claim Challenge / Signature Authorization

Goal: secure one-time authorization for an exact Campaign claim. No
financial reservation ships in this slice.

### Task C1 — Challenge storage migration M1

- [ ] Create the server-private `campaign_claim_challenges` table with TTL,
  consumption, RLS, and grants.

**Files**

- Create: `supabase/migrations/20260916000000_v2c3_claim_challenges.sql`
- Create: `src/lib/campaigns/claim-challenge-migration.db.test.ts`
- Modify: `src/types/database.ts` (regenerated)

**Interfaces**

- Consumes: `participation_campaigns(id)` FK target.
- Produces table `campaign_claim_challenges` with columns `id uuid PK
  DEFAULT gen_random_uuid()`, `campaign_id uuid NOT NULL REFERENCES
  participation_campaigns(id) ON DELETE CASCADE`, `participant_wallet text
  NOT NULL` with canonical lowercase 40-hex `CHECK`,
  `nonce_hash text NOT NULL`, `action text NOT NULL DEFAULT
  'campaign_claim'`, `version integer NOT NULL DEFAULT 1`,
  `message text NOT NULL`, `issued_at timestamptz NOT NULL DEFAULT now()`,
  `expires_at timestamptz NOT NULL` with `expires_at > issued_at` check,
  `consumed_at timestamptz`, `created_at timestamptz NOT NULL DEFAULT
  now()`; indexes on `(campaign_id)`, `(participant_wallet, expires_at)`,
  and unused `(participant_wallet, expires_at) WHERE consumed_at IS NULL`;
  RLS enabled with `REVOKE ALL FROM anon, authenticated` and service-role
  grants only.

**TDD**

- RED: `npx vitest run src/lib/campaigns/claim-challenge-migration.db.test.ts`
  asserting table presence, constraint presence in the catalog, anon-role
  insert refusal, and expiry-check enforcement; M1 is absent so catalog
  assertions fail.
- Implement: the smallest M1 satisfying the assertions.
- GREEN: the suite passes on a clean-room instance migrated from zero;
  db-reset path (`supabase migration up` from zero) applies M1 on top of
  the V2C.2 chain.
- Regression: `npx vitest run src/lib/rewards/settlement-root.db.test.ts`

**Commit:** Fold into slice commit `feat(v2c3c): claim challenge and signature authorization`.

### Task C2 — Challenge issue and signature verification library

- [ ] Add the server-only challenge library with deterministic message
  construction and fail-closed verification.

**Files**

- Create: `src/lib/campaigns/claim-challenge.ts`
- Create: `src/lib/campaigns/claim-challenge.test.ts`
- Create: `src/lib/campaigns/claim-challenge.db.test.ts`

**Interfaces**

- Consumes: `normalizeAddress`, `deriveAddressFromPublicKey`,
  `verifyNimiqMiniAppSignature` from `src/lib/nimiq/server-crypto.ts`,
  `getServerOrigin` from `src/lib/api/origin.ts`,
  `getVerifiedWalletSession` shape `{ address: string }`.
- Produces in `src/lib/campaigns/claim-challenge.ts`:
  `buildCampaignClaimMessage(input: { campaignId: string;
  participantWallet: string; nonce: string; issuedAt: string; expiresAt:
  string; origin: string }): string` (pins Campaign, wallet,
  `campaign_claim` action with version `1`, nonce, timestamps, origin);
  `issueCampaignClaimChallenge(admin, input: { campaignId: string;
  sessionAddress: string }): Promise<{ challengeId: string; message: string;
  expiresAt: string }>` (canonicalizes, stores only the SHA-256 nonce hash
  via `createHash("sha256")`, sets ~5-minute expiry, marks older unused
  challenges for the same wallet consumed); `verifyCampaignClaimSignature(
  admin, input: { challengeId: string; campaignId: string; address: string;
  publicKey: string; signature: string }): Promise<{ kind: "ok";
  participantWallet: string } | { kind: "error"; reasonCode:
  "challenge_not_found" | "challenge_expired" | "challenge_consumed" |
  "wallet_mismatch" | "campaign_mismatch" | "invalid_signature" }>`
  (fail-closed, generic caller-facing mapping, no field-oracle detail).

**TDD**

- RED: `npx vitest run src/lib/campaigns/claim-challenge.test.ts`
  asserting deterministic message bytes, wrong-Campaign rejection,
  wrong-wallet rejection, tampered-message rejection, expired rejection,
  consumed rejection, and raw-nonce absence from storage; the module does
  not exist so the run fails at import. Signatures in unit tests use a real
  `@nimiq/core` keypair following the `vault-key.test.ts` pattern, never a
  hardcoded vector.
- Implement: the smallest library satisfying the unit suite.
- GREEN: unit suite passes; then
  `npx vitest run src/lib/campaigns/claim-challenge.db.test.ts` passes on
  the clean-room instance (nonce-hash uniqueness across issues, expiry
  persistence, consumed-flag lifecycle).
- Regression: `npx vitest run src/app/api/wallet-proof/session/route.test.ts`

**Commit:** Fold into slice commit `feat(v2c3c): claim challenge and signature authorization`.

### Task C3 — Challenge issue route

- [ ] Expose challenge issuance over the Campaign claim route namespace with
  verified-session binding and courtesy eligibility screening.

**Files**

- Create: `src/app/api/campaigns/[campaignId]/claims/challenge/route.ts`
  (`POST`, verified session required)
- Create: `src/app/api/campaigns/[campaignId]/claims/challenge/route.test.ts`

**Interfaces**

- Consumes: `getVerifiedWalletSession`, `normalizeAddress`,
  `isSameOriginRequest`, `issueCampaignClaimChallenge` from Task C2,
  `getPublicCampaignGiveaway` for courtesy screening (published,
  `public_giveaway` type, window, closure, creator exclusion, funding
  readiness snapshot).
- Produces: `201 { challengeId, message, expiresAt }` for eligible
  screening passes; typed rejections `session_missing` (401),
  `invalid_origin` (403), `campaign_not_found` (404),
  `claim_not_available` (422 with `reasonCode` of `not_published`,
  `unsupported_type`, `not_started`, `ended`, `closed`,
  `creator_ineligible`, or `funding_pending`). Screening is documented in
  code as courtesy-only; the authoritative decision stays in slice D.

**TDD**

- RED: route suite asserting 401 without session, 422 for drafts,
  unsupported types, pre-start, ended, closed, creator-owned, and
  funding-pending Campaigns, plus 201 shape for an open Campaign; the route
  does not exist so the run fails at import.
- Implement: the smallest route delegating to Tasks C2 and B1.
- GREEN: the route suite passes on the clean-room instance.
- Regression: existing campaign route suites from Task A3.

**Commit:** Fold into slice commit `feat(v2c3c): claim challenge and signature authorization`.

### Task C4 — Challenge security matrix

- [ ] Lock the C slice with the adversarial matrix: replay, cross-Campaign
  reuse, cross-wallet reuse, tamper, expiry, private-table access, and
  unsupported-type exclusion.

**Files**

- Create: `src/lib/campaigns/claim-challenge-security.db.test.ts`

**Interfaces**

- Consumes: `verifyCampaignClaimSignature` from Task C2, the Task C3 route,
  clean-room `anon` and `authenticated` clients.
- Produces: passing matrix proving consumed challenges never verify twice,
  a signature for Campaign A never verifies for Campaign B, a signature for
  wallet W never verifies for wallet X, tampered messages fail,
  expired challenges fail, `secret_drop`, `private_drop`, `event_drop`,
  and `community_reward` Campaigns never receive challenges, and anon plus
  authenticated roles cannot select, insert, update, or delete
  `campaign_claim_challenges` rows.

**TDD**

- RED: `npx vitest run src/lib/campaigns/claim-challenge-security.db.test.ts`;
  the file does not exist so the run fails at collection.
- Implement: only the test file; any failure it exposes is fixed in Tasks
  C1–C3 code, not by weakening the test.
- GREEN: the full matrix passes on the clean-room instance.
- Regression: full Task C1–C3 suites plus
  `npx vitest run src/lib/campaigns/configuration.test.ts`

**Commit:** `feat(v2c3c): claim challenge and signature authorization`

### Slice V2C.3C exit gate

- [ ] Valid signatures verify exactly once for their Campaign and wallet;
  cross-Campaign, cross-wallet, expired, malformed, tampered, and replayed
  signatures fail closed; challenge storage is service-role only; no
  financial write exists in the slice. No reservation code is touched.

---

## V2C.3D — Atomic Claim / Reservation / Payout Adapter

THIS IS THE CRITICAL BACKEND SLICE. No UI Claim button ships before this
slice is green.

### Task D1 — Campaign source migration M2 plus claim RPC migration M3

- [ ] Land the Campaign-source compatibility migration first and prove it
  GREEN, then create `claim_campaign_reward_atomic` with the exact 12-step
  ordering from spec Section 6, reusing `reward_receipts` as the
  entitlement row. Phase 2 starts only after Phase 1 is GREEN: the receipt
  migration and the atomic reservation behavior that consumes it ship in
  the same reviewed slice.

**Files**

- Create: `supabase/migrations/20260916001000_v2c3_campaign_source_columns.sql`
  (Phase 1: nullable compatibility columns AND shared funding RPC contract
  cutover)
- Create: `src/lib/rewards/v2c3-source-columns.db.test.ts` (Phase 1:
  column/check/index assertions, funding contract and static audits,
  Campaign funding execution, Poll funding regression)
- Modify (Phase 1, same slice): `src/lib/rewards/settlement.ts`
  (`beginFunding`/`bindFunding` RPC args `_campaign_id` to `_settlement_id`
  plus Poll-vocabulary translation of the renamed generic results),
  `src/lib/rewards/funding-confirmation.ts` (`confirmAtomic` RPC arg
  `_campaign_id` to `_settlement_id`),
  `src/app/api/polls/[pollId]/reward/funding/intents/[intentId]/confirm/route.ts`
  (Poll publicity pre-check mirroring the intent and bind routes, since the
  shared engine no longer emits Poll wording),
  `src/lib/rewards/settlement.test.ts` (RPC arg assertions
  `_campaign_id` to `_settlement_id`),
  `src/lib/campaigns/funding.test.ts` (RPC arg assertions
  `_campaign_id` to `_settlement_id`; asserted values unchanged),
  `src/lib/rewards/funding-confirmation.db.test.ts` (direct
  `confirm_reward_funding_atomic` invocation arg `_campaign_id` to
  `_settlement_id`)
- Create: `supabase/migrations/20260916002000_v2c3_campaign_claim_rpc.sql`
  (Phase 2)
- Create: `src/lib/rewards/campaign-claim-rpc.db.test.ts` (Phase 2)
- Modify: `src/types/database.ts` (regenerated once after Phase 1 and again
  after Phase 2; no table change in M3)

**Interfaces**

Phase 1 consumes the existing `reward_funding_transactions`,
`reward_receipts`, and `reward_refunds` definitions plus the
`settlement_source_bindings` Campaign branch, the three Poll-shaped funding
RPC definitions in
`supabase/migrations/20260913085000_v2c2_financial_root_cutover.sql`, and
their exact TypeScript callers: `src/lib/rewards/settlement.ts`
(`beginFunding` calling `begin_reward_funding_atomic` with `_campaign_id`,
`bindFunding` calling `bind_reward_funding_transaction_atomic` with
`_campaign_id`) and `src/lib/rewards/funding-confirmation.ts`
(`confirmAtomic` calling `confirm_reward_funding_atomic` with
`_campaign_id`). No SQL-internal callers exist; all invocations use named
arguments through these three call sites.
- Produces (schema): nullable `campaign_id`/`poll_id` compatibility columns
  governed by `CHECK` constraints enforcing exactly one source identity per
  row: Poll rows keep `campaign_id IS NOT NULL AND poll_id IS NOT NULL`;
  Campaign rows use `campaign_id IS NULL AND poll_id IS NULL` with
  `settlement_id IS NOT NULL`; plus a settlement-scoped receipt uniqueness
  index `UNIQUE (settlement_id, lower(trim(participant_wallet)))` expressed
  as a unique expression index, with RLS and grants unchanged (service-role
  only). No `participation_campaign_id` column is added to any financial
  table.
- Produces (contract cutover): the same three RPC names with identical
  argument TYPE signatures under the canonical `_settlement_id` first
  argument, via explicit `DROP FUNCTION` plus `CREATE FUNCTION` in M2 (never
  `CREATE OR REPLACE` alone, never an overload, never a wrapper). Generic
  resolution inside each RPC: `_settlement_id` locks `reward_settlements`,
  resolves `settlement_source_bindings` to exactly one owning product
  source, then follows branch A (Poll: `source_type =
  'poll_reward_campaign'` with the historical `reward_campaigns`
  compatibility row, used for ownership and product compatibility checks
  only) or branch B (Campaign: `source_type = 'participation_campaign'`
  with `participation_campaigns` present and no `reward_campaigns` row
  created or fabricated). All economics and lifecycle state load from the
  locked settlement row. Funding-row inserts carry the Poll adapter UUID in
  `campaign_id` on branch A and `NULL` on branch B; `settlement_id` is
  authoritative for both. `SECURITY DEFINER`, `search_path`, volatility,
  ownership, `REVOKE ALL FROM PUBLIC, anon, authenticated`, and `GRANT
  EXECUTE TO service_role` are restored exactly.
- Produces (generic errors): the funding RPCs emit only `created`,
  `replay`, `bound`, `bound_replay`, `confirmed`, `settlement_not_found`,
  `source_not_supported`, `funding_not_allowed`, `funding_conflict`,
  `transaction_already_reserved`, and the unchanged neutral intent, hash,
  amount, terms, and vault codes. Poll-shaped codes are never emitted by
  the engine.
- Produces (Poll translation, outside the engine): `src/lib/rewards/settlement.ts`
  result parsers map `settlement_not_found` and `source_not_supported` to
  `campaign_not_found`, `funding_not_allowed` to `forbidden`, and
  `funding_conflict` to `campaign_state_conflict`, so every existing Poll
  route, response shape, and status code is byte-identical; the same mapping
  applies anywhere these codes surface on the confirm path
  (`reconcileFundingIntent` in `src/lib/rewards/funding-confirmation.ts`),
  keeping `confirm_reward_funding_atomic` callers on the existing Poll
  vocabulary. Poll publicity
  gating stays at the Poll route and adapter pre-checks: the intent and
  bind routes already check `is_public`, and the confirm route gains the
  same pre-check in this slice (aligning its private-poll outcome with the
  existing `private_poll_not_rewardable` 422 instead of an engine 500).
  Campaign translation lives in `src/lib/campaigns/funding.ts`:
  `settlement_not_found` and `source_not_supported` to `campaign_not_found`,
  `funding_not_allowed` to `forbidden`, `funding_conflict` to
  `campaign_state_conflict`, matching the already-shipped A3 route mapping.
- Produces (regenerated types): `src/types/database.ts` Functions entries
  for the three RPCs with `_settlement_id: string` first args; all other
  entries unchanged.
This is the impossibility justification the spec requires: the spec
default (reuse `reward_receipts`, no second table) is literally impossible
against the shipped Poll-shaped `NOT NULL` FKs, because a standalone
Campaign row must never fabricate a `reward_campaigns` row or a `polls`
row, must keep exactly one source identity, must keep settlement-scoped
uniqueness, and must leave `reward_settlements` as the financial
authority. The adaptation keeps one ledger and adds a Campaign branch to
it; no parallel `campaign_claim` financial table and no
`begin/bind/confirm_campaign_funding_atomic` fork is created.

Phase 2 consumes `participation_campaigns`,
`settlement_source_bindings` (Campaign branch), `reward_settlements`,
`reward_receipts`, and `campaign_claim_challenges`.
- Produces: `claim_campaign_reward_atomic(_campaign_id uuid,
  _participant_wallet text, _challenge_id uuid) RETURNS jsonb LANGUAGE
  plpgsql SECURITY DEFINER SET search_path = ''`, executing in order:
  (1) lock `reward_settlements` via Campaign→binding→settlement resolution
  (`FOR UPDATE`); (2) lock and recheck the challenge row (Campaign match,
  wallet match, action/version match, `now() < expires_at`,
  `consumed_at IS NULL`); (3) existing-receipt lookup by
  `(settlement_id, lower(trim(participant_wallet)))` returning
  `result_kind = 'replay'` with `consumed_at` set in the same commit when a
  row exists; (4) full eligibility re-check (`campaign_type =
  'public_giveaway'`, `status = 'published'`, `now() >= starts_at`,
  `now() < ends_at`, settlement `status IN ('funded','rewarding')`,
  capacity, creator exclusion); (5) insert `reward_receipts` with
  `campaign_id IS NULL, poll_id IS NULL, settlement_id, participant_wallet,
  amount_luna = reward_per_participant_luna, status = 'reserved'` guarded by
  `ON CONFLICT` on the settlement-scoped index falling back to replay;
  (6) counter increment, `funded → rewarding → exhausted` transition,
  `first_reservation_at = COALESCE(first_reservation_at, now())`; (7)
  `consumed_at = now()` on the challenge; single commit returning
  `reserved` or `replay` with `receipt_id`, `settlement_id`,
  `amount_luna`, `status`, `rewards_remaining`, or typed
  `campaign_not_found | challenge_invalid | challenge_expired |
  challenge_consumed | campaign_not_published | unsupported_type |
  claim_not_started | claim_ended | campaign_closed |
  campaign_not_funded | creator_not_eligible | no_reward_capacity`.
  `REVOKE ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO
  service_role;`.

**TDD**

- RED (Phase 1): `npx vitest run src/lib/rewards/v2c3-source-columns.db.test.ts`
  against the clean-room instance before M2 applies, proving (a) inserting
  a Campaign funding intent row with `campaign_id IS NULL` fails on the
  `NOT NULL` constraint, (b) the new `CHECK` names are absent from the
  catalog, and (c) calling any of the three funding RPCs with a standalone
  Campaign settlement returns `campaign_not_found` from the Poll-only
  source path. All three RED conditions must be recorded before M2.
- Implement (Phase 1) in the mandated order:
  1. Apply the M2 schema and source compatibility: preflight aborting when
     any existing row violates the Poll-branch shape, drop the four
     `NOT NULL` constraints, add the branch `CHECK` constraints, add the
     settlement-scoped receipt uniqueness index, leave every existing Poll
     row byte-identical.
  2. Cut the shared funding RPC contract: `DROP FUNCTION` plus `CREATE
     FUNCTION` for `begin_reward_funding_atomic`,
     `bind_reward_funding_transaction_atomic`, and
     `confirm_reward_funding_atomic` with identical argument TYPE
     signatures under `_settlement_id`, generic settlement-to-binding
     resolution for both branches, settlement-derived economics,
     branch-A `campaign_id` compatibility writes and branch-B `NULL`
     writes, source-neutral error vocabulary, and identical security,
     volatility, grants, and ownership. No overload, wrapper, or
     `begin/bind/confirm_campaign_funding_atomic` fork.
  3. Update every server-side caller atomically in the same slice:
     `src/lib/rewards/settlement.ts` (`beginFunding`, `bindFunding`),
     `src/lib/rewards/funding-confirmation.ts` (`confirmAtomic`), plus the
     Poll publicity pre-check on the confirm route and the Poll-vocabulary
     translation in the settlement result parsers.
  4. Update the asserting tests to the new contract:
     `src/lib/rewards/settlement.test.ts`, `src/lib/campaigns/funding.test.ts`,
     and `src/lib/rewards/funding-confirmation.db.test.ts` expect
     `_settlement_id` keys with unchanged values.
  5. Regenerate `src/types/database.ts` and verify the three Functions
     entries carry `_settlement_id: string` first args.
- GREEN (Phase 1): the same suite passes; all pre-existing Poll rows
  validate against the new checks; `supabase migration up` from zero on a
  disposable project applies the full chain including M1 then M2; the suite
  additionally proves Campaign-branch funding execution end to end through
  the Task A2 adapter and Task A3 routes: standalone Campaign settlement
  begins funding with no `reward_campaigns` row required, the funding row
  carries the correct `settlement_id` with `campaign_id IS NULL`,
  replay returns the same intent, the designated creator funder is
  enforced, vault and exact amount are server-derived, bind succeeds, hash
  reuse across settlements is rejected, confirmation covers underpayment
  rejection and overpayment accounting with macro finality, and the
  settlement reaches reward-ready; plus Campaign-branch refund-row
  compatibility, plus Poll regression (Poll funding begins with the
  compatibility `campaign_id` retained and `settlement_id` authoritative,
  existing route and service response behavior unchanged, legacy error
  vocabulary preserved at the Poll boundary, and
  `npx vitest run src/lib/rewards/settlement-child-compatibility.db.test.ts src/lib/rewards/reservation.db.test.ts src/lib/campaigns/configuration.db.test.ts`
  green), plus static audits from the catalog: generated RPC args use
  `_settlement_id` for all three funding RPCs, zero `_campaign_id`
  invocations remain for these RPCs in `src/` and in `pg_proc` argument
  names, zero `begin/bind/confirm_campaign_funding_atomic` functions
  exist, zero `participation_campaign_id` columns exist on
  `reward_funding_transactions`, zero financial writes target
  `reward_campaigns` (the existing `financial-authority-cutover` and
  `settlement-root` authority audits stay green).
  No Phase 2 work starts until this gate is GREEN.
- RED (Phase 2): `npx vitest run src/lib/rewards/campaign-claim-rpc.db.test.ts`
  covering the eligibility matrix, replay-before-capacity, creator
  exclusion with case-variant addresses, and `first_reservation_at`
  exactly-once; the RPC does not exist so calls fail with
  `function does not exist`.
- Implement (Phase 2): the smallest M3 satisfying the suite.
- GREEN (Phase 2): the suite passes on a clean-room instance migrated from
  zero (M1, M2, M3 in order).
- Regression: `npx vitest run src/lib/rewards/reservation.db.test.ts src/lib/rewards/settlement-child-compatibility.db.test.ts`
  proving `claim_reward_receipt_atomic` behavior is unchanged.

**Commit:** Fold into slice commit `feat(v2c3d): atomic campaign claim and payout adapter`.

### Task D2 — Campaign participation adapter

- [ ] Add the thin `public_giveaway` adapter returning the existing minimal
  context shape.

**Files**

- Create: `src/lib/rewards/campaign-participation-adapter.ts`
- Create: `src/lib/rewards/campaign-participation-adapter.test.ts`

**Interfaces**

- Consumes: `RewardParticipationAdapter` contract and
  `parseRewardParticipationContext` from
  `src/lib/rewards/participation.ts`, `normalizeAddress`,
  `resolveCampaignRewardSettlement`.
- Produces: `CampaignRewardParticipationRequest = { campaignId: string;
  challengeId: string; verifiedSession: { address: string } }`,
  `createCampaignRewardParticipationAdapter(store:
  CampaignRewardParticipationStore)` with store methods `loadCampaign(
  campaignId)` (type, status, owner, window), `loadSettlementBinding(
  campaignId)` (settlement ID plus binding source ID), and
  `loadChallenge(challengeId)` (Campaign binding plus unconsumed status),
  resolving to `{ kind: "eligible"; context }` with `source.type =
  "campaign_claim"`, `eligibility.evidenceKind = "verified_wallet_claim"`,
  `eligibility.evidenceId = challengeId`, or typed `ineligible` codes
  (`invalid_request`, `campaign_not_found`, `unsupported_type`,
  `campaign_not_published`, `session_wallet_mismatch`,
  `challenge_wallet_mismatch`, `challenge_campaign_mismatch`,
  `creator_not_reward_eligible`, `settlement_binding_missing`,
  `source_resolution_failed`), plus
  `createSupabaseCampaignRewardParticipationStore(admin)`. The adapter
  carries no amount, capacity, vault, or lifecycle data.

**TDD**

- RED: `npx vitest run src/lib/rewards/campaign-participation-adapter.test.ts`
  with stubbed stores covering session mismatch, challenge mismatch,
  creator exclusion, unsupported types, and the eligible context shape; the
  module does not exist so the run fails at import.
- Implement: the smallest adapter satisfying the suite.
- GREEN: the unit suite passes.
- Regression: `npx vitest run src/lib/rewards/participation.test.ts src/lib/rewards/poll-participation-adapter.test.ts`

**Commit:** Fold into slice commit `feat(v2c3d): atomic campaign claim and payout adapter`.

### Task D3 — Reservation service Campaign branch

- [ ] Extend `RewardReservationService` to accept verified Campaign contexts
  while keeping the Poll path byte-identical in behavior.

**Files**

- Modify: `src/lib/rewards/reservation-service.ts` (add
  `hasCampaignEvidence` parity check, extend `RewardReservationAuthority`
  `sourceType` to `"poll_vote" | "campaign_claim"`, add
  `loadCampaignAuthority` path in
  `createSupabaseRewardReservationStore` resolving Campaign→binding→
  settlement and owner, route `reserveAtomic` to
  `claim_campaign_reward_atomic` for `campaign_claim` contexts)
- Create: `src/lib/rewards/campaign-reservation.test.ts`
- Create: `src/lib/rewards/campaign-reservation.db.test.ts`

**Interfaces**

- Consumes: Task D2 contexts, `claim_campaign_reward_atomic` from Task D1,
  `claim_reward_receipt_atomic` (Poll path, untouched).
- Produces: extended `reserve(context)` returning the existing
  `RewardReservationResult` union (`reserved | replay | ineligible |
  rejected`) for both source types, with Campaign rejections mapped to the
  D1 `result_kind` vocabulary. Poll evidence validation, authority
  matching, and result parsing for `poll_vote` are unchanged lines.

**TDD**

- RED: `npx vitest run src/lib/rewards/campaign-reservation.test.ts`
  asserting Campaign eligible→reserved, duplicate→replay,
  creator→ineligible, and Poll-context behavior identical to the existing
  suite; the branch does not exist so Campaign cases fail.
- Implement: the smallest extension satisfying the suite.
- GREEN: unit suite passes; then the db suite passes on the clean-room
  instance through the real M3 RPC.
- Regression: `npx vitest run src/lib/rewards/reservation-service.test.ts src/lib/rewards/v2c1-compatibility.test.ts "src/app/api/polls/[pollId]/vote/route.test.ts"`

**Commit:** Fold into slice commit `feat(v2c3d): atomic campaign claim and payout adapter`.

### Task D4 — Signed claim submission route

- [ ] Expose the atomic claim over `POST
  /api/campaigns/[campaignId]/claims` with signature verification outside
  the mutation and reservation inside it.

**Files**

- Create: `src/app/api/campaigns/[campaignId]/claims/route.ts`
- Create: `src/app/api/campaigns/[campaignId]/claims/route.test.ts`

**Interfaces**

- Consumes: `getVerifiedWalletSession`, `isSameOriginRequest`,
  `verifyCampaignClaimSignature` (Task C2, verification only, no
  consumption), `createCampaignRewardParticipationAdapter` (Task D2),
  `createRewardReservationService` (Task D3), `createRewardSettlementService`
  (`executePayout` enqueued after a `reserved`/`replay` receipt with
  receipt status `reserved` or `payout_pending`, mirroring
  `src/app/api/polls/[pollId]/vote/route.ts` follow-up semantics).
- Produces: `201 { receiptId, settlementId, status, replayed: boolean }`
  for new and replayed entitlements; typed failures `session_missing`
  (401), `invalid_origin` (403), `challenge_invalid |
  challenge_expired | challenge_consumed | wallet_mismatch |
  campaign_mismatch | invalid_signature` (422), and reservation rejections
  mapped from D1 codes (`not_published`, `unsupported_type`,
  `not_started`, `ended`, `closed`, `funding_pending`,
  `creator_ineligible`, `sold_out`). The route never consumes the challenge
  itself; consumption happens only inside M3.

**TDD**

- RED: route suite asserting unsigned requests cannot claim (401/422),
  valid signed claims return 201, duplicate submissions return the same
  `receiptId` with `replayed: true`, and creator claims are rejected; the
  route does not exist so the run fails at import.
- Implement: the smallest route satisfying the suite.
- GREEN: the route suite passes on the clean-room instance.
- Regression: Task C3 suite plus Poll vote route suite.

**Commit:** Fold into slice commit `feat(v2c3d): atomic campaign claim and payout adapter`.

### Task D5 — Concurrency and race suite

- [ ] Prove the Section 6 concurrency semantics against the real RPC under
  parallel load.

**Files**

- Create: `src/lib/rewards/campaign-claim-concurrency.db.test.ts`

**Interfaces**

- Consumes: `claim_campaign_reward_atomic`, Task D4 route handler,
  clean-room instance with configurable `max_rewarded_participants`.
- Produces: passing proofs for same-wallet double-click (one receipt),
  same-wallet multiple tabs (`Promise.all` of 8 parallel claims → one
  receipt, seven replays), replayed HTTP request after success (same
  receipt, no counter movement), two wallets racing the final slot of a
  one-capacity Campaign (one `reserved`, one `no_reward_capacity`, counter
  exactly 1), claim versus early close (in-transaction order decides; no
  torn outcome), claim versus scheduled expiry (same rule),
  HTTP-uncertainty retry with a fresh challenge (existing receipt), and
  `first_reservation_at` set exactly once across all races.

**TDD**

- RED: the file does not exist so the run fails at collection; each case is
  written to fail against a naive non-atomic implementation (asserted by
  running the same file once against a deliberately unlocked draft RPC in a
  scratch migration that is deleted before GREEN — the scratch file never
  commits).
- Implement: only the test file plus M3 hardening the failures expose.
- GREEN: the full suite passes on the clean-room instance three consecutive
  runs.
- Regression: `npx vitest run src/lib/rewards/payout.db.test.ts`

**Commit:** Fold into slice commit `feat(v2c3d): atomic campaign claim and payout adapter`.

### Task D6 — Campaign payout integration proof

- [ ] Prove campaign receipts settle through the unchanged payout engine
  with exact vault, recipient, amount, retry, and finality behavior.

**Files**

- Create: `src/lib/rewards/campaign-payout.db.test.ts`

**Interfaces**

- Consumes: `executeReservedRewardPayout` from `src/lib/rewards/payout.ts`
  via `createRewardSettlementService(admin).executePayout(settlementId,
  receiptId)`, `withRewardSettlementVaultKey`,
  `createNimiqTransactionObservationAdapter` with stubbed transport
  following the `payout-reconciliation.test.ts` pattern, campaign receipts
  created through Task D1.
- Produces: passing proofs that payout sends from the correct settlement
  vault to the exact receipt wallet for the exact
  `reward_per_participant_luna`, hash-bearing uncertainty is never
  blindly resent, bounded hashless pre-broadcast retry is the only
  resend path, `paid` requires canonical inclusion plus finalizing
  macro-block evidence through `confirm_reward_payout_atomic`, and two
  payout executions for one receipt yield one attempt lineage without
  duplicate broadcast.

**TDD**

- RED: the file does not exist so the run fails at collection.
- Implement: only the test file; production payout code is untouched.
- GREEN: the suite passes on the clean-room instance.
- Regression: `npx vitest run src/lib/rewards/payout-reconciliation.db.test.ts src/lib/rewards/payout.test.ts src/lib/rewards/reconciliation.test.ts`

**Commit:** `feat(v2c3d): atomic campaign claim and payout adapter`

### Slice V2C.3D exit gate

- [ ] Migration M2 and the claim RPC land together: source compatibility is
  GREEN with Poll behavior preserved before any reservation executes.
  The shared funding contract cutover is complete: one `_settlement_id`
  contract per operation with no surviving overload or fork, Poll funding
  behavior identical at its boundary including legacy vocabulary,
  Campaign-branch funding execution GREEN with `campaign_id IS NULL` rows,
  and static audits GREEN. Signed claims atomically produce exactly one
  durable receipt and hand
  off to the existing payout engine; duplicate races yield one receipt,
  final-slot races yield one winner, retries replay, creator self-claims
  fail at adapter and RPC layers, close/expiry races resolve cleanly, and
  no UI claim control exists yet. Poll reservation and payout suites stay
  green.

---

## V2C.3E — Claim NIM UX + Durable Participant Status

Goal: expose the proven D backend through participant UX. This slice starts
only after the D exit gate is green.

### Task E1 — Claim action hook and button

- [ ] Add the client claim flow: challenge request, wallet signature,
  signed submit, and safe error mapping.

**Files**

- Create: `src/hooks/useCampaignClaim.ts`
- Create: `src/components/campaign/ClaimNimButton.tsx`
- Create: `src/components/campaign/ClaimNimButton.test.tsx`

**Interfaces**

- Consumes: `useNimiqContext` (`provider`, `isInsideNimiqPay`) from
  `src/providers/NimiqProvider.tsx`, `useVotumSession`
  (`isSessionVerified`, `isWalletMatched`, `verifyActiveWallet`) from
  `src/providers/VotumSessionProvider.tsx`, `signMessage` from
  `src/lib/nimiq/client.ts`, `POST
  /api/campaigns/[campaignId]/claims/challenge` and `POST
  /api/campaigns/[campaignId]/claims`.
- Produces: `useCampaignClaim(campaignId)` returning `{ phase:
  "idle" | "requesting_challenge" | "awaiting_signature" |
  "submitting" | "done" | "error"; receiptId: string | null; replayed:
  boolean; errorCode: string | null; start: () => Promise<void> }` and
  `ClaimNimButton` rendering the Signal Gold single CTA with
  text-plus-icon states. Wallet-signature rejection maps to a calm
  `signature_rejected` message with a restart affordance; server rejections
  map one-to-one to route codes without internals.

**TDD**

- RED: `npx vitest run src/components/campaign/ClaimNimButton.test.tsx`
  with mocked provider and fetch covering success, user-denied signature,
  expired challenge, sold-out, and creator-ineligible mappings; files do
  not exist so the run fails at import.
- Implement: the smallest hook plus button satisfying the suite.
- GREEN: the suite passes under jsdom.
- Regression: `npx vitest run src/components/ui/WalletButton.test.tsx`

**Commit:** Fold into slice commit `feat(v2c3e): claim NIM UX and durable status`.

### Task E2 — Participant status surface

- [ ] Add the derived five-state status panel with proof references and no
  retry control.

**Files**

- Create: `src/components/campaign/CampaignClaimStatus.tsx`
- Create: `src/components/campaign/CampaignClaimStatus.test.tsx`

**Interfaces**

- Consumes: `GET /api/campaigns/[campaignId]/claims/mine` (Task B4) polled
  on an interval plus on window focus; receipt-derived mapping
  `reserved → "Claim reserved"`, attempt pre-broadcast/broadcast-started →
  `"Sending NIM"`, broadcast hash under observation → `"Confirming
  on-chain"`, receipt `paid → "Paid"`, retryable/unknown/manual-review →
  `"Payout delayed"` with entitlement-intact copy.
- Produces: status panel with IBM Plex Mono proof data (shortened wallet,
  transaction reference, timestamp), Verified Green only for Paid, NIM Blue
  for proof context, and explicitly no button, link, or handler that
  retries, resends, or broadcasts a payout.

**TDD**

- RED: component suite asserting all five states, delayed-state copy, proof
  rendering, and absence of any retry affordance (query for retry text
  returns null); files do not exist so the run fails at import.
- Implement: the smallest component satisfying the suite.
- GREEN: the suite passes under jsdom.
- Regression: `npx vitest run src/components/poll/PollResultPanel.test.tsx src/components/poll/VotumReceiptView.test.tsx`

**Commit:** Fold into slice commit `feat(v2c3e): claim NIM UX and durable status`.

### Task E3 — Page wiring and enablement gating

- [ ] Wire the button and status into the share-link page, enabled only
  when the derived state is open.

**Files**

- Modify: `src/app/campaigns/[campaignId]/page.tsx` (compose
  `CampaignGiveawayView`, `ClaimNimButton`, `CampaignClaimStatus`; pass the
  server DTO only)
- Modify: `src/components/campaign/CampaignGiveawayView.tsx` (accept
  `claimState` plus session-aware slots; render Claim NIM enabled only for
  `open` with a verified matching wallet)
- Create: `src/app/campaigns/[campaignId]/page.test.tsx` (server-actionable
  assertions via the DTO contract and component composition)

**Interfaces**

- Consumes: `PublicCampaignGiveaway.claimState` (Task B1),
  `useVotumSession` match state, Task E1 and E2 components.
- Produces: creator views showing the ineligible state with management
  affordances only; scheduled (`starts_soon`), funding-pending
  (`needs_funding`), sold-out (`full`), ended (`ended`), and closed
  (`closed`) views with Claim NIM disabled and the reason stated in
  brand-messaging vocabulary.

**TDD**

- RED: page suite asserting enabled-only-when-open across all seven
  `claimState` values plus creator and unverified-wallet variants; wiring
  does not exist so assertions fail.
- Implement: the smallest wiring satisfying the suite.
- GREEN: the suite passes; `npm run build` succeeds.
- Regression: `npx tsc --noEmit`

**Commit:** Fold into slice commit `feat(v2c3e): claim NIM UX and durable status`.

### Task E4 — Participant UX regression matrix

- [ ] Lock the slice with end-to-end-shaped route and component tests for
  the mandated UX cases.

**Files**

- Create: `src/app/campaigns/[campaignId]/claims-ux.db.test.ts` (route-level
  matrix on the clean-room instance)
- Create: `src/components/campaign/claim-ux-matrix.test.tsx` (component
  matrix under jsdom)

**Interfaces**

- Consumes: Task D4 route, Task B4 route, Task E1–E3 components.
- Produces: passing proofs that unsigned requests cannot claim, creators
  see the ineligible state, scheduled, funding-pending, sold-out, ended,
  and closed Campaigns reject with mapped copy, successful signing yields
  the receipt, user-rejected signatures recover cleanly, duplicate
  submission returns the same claim with `replayed: true`, reload returns
  own status without re-signing, and claimant A responses contain no data
  about claimant B. The reload case is the first positive claimant proof
  for the Task B4 read, deferred from slice B because no claimant fixture
  can exist before slice D.

**TDD**

- RED: both files do not exist so runs fail at collection.
- Implement: only the two test files; failures fix Tasks E1–E3, never the
  D backend contract.
- GREEN: both suites pass (db suite on the clean-room instance).
- Regression: full slice B, C, and D suites.

**Commit:** `feat(v2c3e): claim NIM UX and durable status`

### Slice V2C.3E exit gate

- [ ] A participant completes signed claim → reservation → paid proof from
  the share link, survives reload without re-signing, sees accurate
  delayed-state copy when payout lags, and no retry-send control exists in
  any component, hook, or route.

---

## V2C.3F — Close / Refund + Full Vertical Slice Gate

Goal: complete lifecycle and prove the whole Public Giveaway is coherent.

### Task F1 — Creator early close

- [ ] Add owner-authorized early close that stops new claims while
  preserving reservations.

**Files**

- Create: `src/lib/campaigns/close.ts`
- Create: `src/lib/campaigns/close.test.ts`
- Create: `src/lib/campaigns/close.db.test.ts`
- Create: `src/app/api/campaigns/[campaignId]/close/route.ts` (`POST`,
  verified owner session required)
- Create: `src/app/api/campaigns/[campaignId]/close/route.test.ts`

**Interfaces**

- Consumes: `getVerifiedWalletSession`, `normalizeAddress`,
  `isSameOriginRequest`, `resolveCampaignRewardSettlement`.
- Produces: `closeParticipationCampaign(admin, campaignId, ownerWallet):
  Promise<{ kind: "closed" | "replay"; settlementId: string } | { kind:
  "error"; reasonCode: "campaign_not_found" | "forbidden" |
  "invalid_state" }>` setting `participation_campaigns.status = 'closed'`
  with `close_reason = 'creator_cancelled'` and moving the settlement out
  of reward-ready states through the existing closure transition used by
  the Poll path; route returns `200 { settlementId, closed: true }` or
  typed `session_missing` (401), `forbidden` (403),
  `campaign_not_found` (404), `invalid_state` (409).

**TDD**

- RED: unit plus route suites asserting owner-only close, non-owner 403,
  double-close replay, and post-close claim rejection with surviving
  pre-close reservations; files do not exist so runs fail at import.
- Implement: the smallest library plus route satisfying the suites.
- GREEN: suites pass on the clean-room instance.
- Regression: `npx vitest run src/lib/rewards/poll-closure-adapter.test.ts src/lib/rewards/closure.test.ts`

**Commit:** Fold into slice commit `feat(v2c3f): close refund and vertical slice gate`.

### Task F2 — Campaign refund-begin RPC and closure adapter

- [ ] Add migration M4 plus the Campaign closure adapter mirroring the Poll
  closure adapter.

**Files**

- Create: `supabase/migrations/20260916003000_v2c3_campaign_close_refund.sql`
- Create: `src/lib/rewards/campaign-closure-adapter.ts`
- Create: `src/lib/rewards/campaign-closure-adapter.test.ts`
- Create: `src/lib/rewards/campaign-close-refund.db.test.ts`
- Modify: `src/types/database.ts` (regenerated)

**Interfaces**

- Consumes: `RewardClosureTrigger`/`RewardClosureContext` from
  `src/lib/rewards/closure.ts`, `classifyRewardObligations` and
  `calculateRefundableRewardAmount` from
  `src/lib/rewards/refund-policy.ts`, Campaign→binding→settlement
  resolution, verified session token hash via `hashToken`.
- Produces: `begin_campaign_refund_atomic(_settlement_id uuid,
  _session_token_hash text) RETURNS jsonb SECURITY DEFINER SET search_path
  = ''` validating the Campaign binding branch, owner authorization,
  product closure (`status = 'closed'` or window elapsed), zero unresolved
  obligations (reserved, payout-pending, retryable, hash-bearing-unknown,
  manual-review all block), accounting reconciliation, and single frozen
  refund intent creation with server-derived recipient and amount, grants
  service-role only; plus `createCampaignRewardClosureAdapter` mapping
  Campaign `closed`/elapsed-`ends_at`/cancelled into the source-neutral
  trigger with `source.type = "campaign_claim"`, and reusing
  `prepare_reward_refund_transaction_atomic`,
  `mark_reward_refund_broadcast_starting_atomic`,
  `mark_reward_refund_broadcast_atomic`, and
  `confirm_reward_refund_atomic` unchanged for execution.

**TDD**

- RED: `npx vitest run src/lib/rewards/campaign-closure-adapter.test.ts`
  plus the db suite asserting refund blocked while obligations exist,
  allowed after settlement, zero-remainder terminal handling, and
  server-derived destination; the RPC and adapter do not exist so runs fail
  at import and with `function does not exist`.
- Implement: the smallest M4 plus adapter satisfying the suites.
- GREEN: suites pass on a clean-room instance migrated from zero
  (M1–M4 in order).
- Regression: `npx vitest run src/lib/rewards/refund-preparation.db.test.ts src/lib/rewards/refund-reconciliation.db.test.ts src/lib/rewards/refund-policy.test.ts`

**Commit:** Fold into slice commit `feat(v2c3f): close refund and vertical slice gate`.

### Task F3 — Refund execution reuse proof

- [ ] Prove Campaign refunds execute through the unchanged refund engine
  with server-derived destination and amount plus finality-gated terminal
  state.

**Files**

- Create: `src/lib/rewards/campaign-refund-execution.db.test.ts`

**Interfaces**

- Consumes: `executeRewardRefund` from `src/lib/rewards/refund.ts`,
  `confirmRewardRefund` path from
  `src/lib/rewards/refund-reconciliation.ts`,
  `createNimiqTransactionObservationAdapter` with stubbed transport,
  campaign settlements carrying paid receipts plus an unused remainder.
- Produces: passing proofs that the refund recipient equals the immutable
  settlement owner/funder policy value, the amount equals the reconciled
  remainder capped by policy, browser-supplied destinations are ignored
  (no such parameter exists on any touched function), broadcast follows the
  durable pre-broadcast markers with no blind resend, and `refunded`
  requires exact observed transfer plus macro finality.

**TDD**

- RED: the file does not exist so the run fails at collection.
- Implement: only the test file; refund engine code is untouched.
- GREEN: the suite passes on the clean-room instance.
- Regression: `npx vitest run src/lib/rewards/refund.db.test.ts src/lib/rewards/refund-reconciliation.test.ts`

**Commit:** Fold into slice commit `feat(v2c3f): close refund and vertical slice gate`.

### Task F4 — Full synthetic vertical-slice lifecycle

- [ ] Encode the mandated deterministic lifecycle as one clean-room suite.

**Files**

- Create: `src/lib/rewards/v2c3-public-giveaway-e2e.db.test.ts`

**Interfaces**

- Consumes: Task A2–A4 functions and routes, Task B1 projector, Task C2
  challenge library, Task D2–D4 claim path, `executePayout` and
  reconciliation helpers, Task F1 close, Task F2 refund path, real
  `@nimiq/core` keypairs for participant and creator wallets.
- Produces: one deterministic run proving creator creates → configures
  reward × capacity → settlement vault exists → funds exact budget →
  funding finality → publishes → participant opens share URL (projector
  `open`) → challenge → signs → claims → one receipt → payout → finality →
  Paid proof → second participant claims → creator closes early → third
  participant rejected → existing obligations settle → unused remainder
  refunded → terminal closure. Wallet fixtures use
  `"01" + randomBytes(19).toString("hex")` canonical form; docker psql
  cleanup follows the `reservation.db.test.ts` pattern; no hosted instance
  is contacted (`assertLocalSupabaseForTests` plus clean-room overrides).

**TDD**

- RED: the file does not exist so the run fails at collection; stage the
  lifecycle incrementally against slices A–E completions, recording each
  red step (challenge without C, claim without D, refund without F2).
- Implement: only the test file.
- GREEN: the full lifecycle passes on a clean-room instance migrated from
  zero three consecutive runs.
- Regression: entire V2C.3A–E suites.

**Commit:** Fold into slice commit `feat(v2c3f): close refund and vertical slice gate`.

### Task F5 — Final verification and completion gate

- [ ] Run every gate in the mandated list and record results in the
  completion commit message body.

**Files**

- Modify: none (verification only; failures return their tasks to RED)

**Interfaces**

- Consumes: the full working tree at slice F completion.
- Produces: recorded evidence for Poll backward compatibility (free Poll,
  legacy_support, rewarded reward_first, creator vote without reward,
  option economic isolation, one wallet one vote, receipt and payout
  behavior, public Poll response shapes via `vote-test.ts`,
  `v2b1-backward-test.ts`, `v2b2-config-test.ts`,
  `v2b2-funding-test.ts`), funding contract singularity re-audit
  (`_settlement_id` args, zero overloads or forks, zero
  `participation_campaign_id` funding columns, legacy Poll vocabulary at
  the boundary), clean migration from zero plus db-reset path,
  schema parity (`src/types/database.ts` matches the migrated clean-room
  catalog), RLS and privacy probes (anon plus authenticated roles read no
  private row and no claimant list exists on any public surface),
  financial single-authority audit (every money write resolves through
  `reward_settlements`; vault reads resolve through `settlement_id`),
  unsupported-strategy exclusion (no route or adapter accepts non
  `public_giveaway` claims), manual-retry absence (codebase search for
  retry affordances in `src/components/campaign/*` and
  `src/app/campaigns/**` returns nothing participant-triggered), full
  Vitest run, TypeScript check, lint, production build, and diff check
  confirming only V2C.3 files changed.

**TDD**

- RED: any gate failure reopens its owning task; the completion commit is
  blocked until all gates pass.
- Implement: no production change in this task.
- GREEN commands in order:
  `npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism`,
  `npx tsc --noEmit`, `npm run lint`, `npm run build`,
  `git status --porcelain`, `git diff --stat origin/feat/v2-participation-record`.
- Regression: the union of all slice suites.

**Commit:** `feat(v2c3): complete Public Giveaway vertical slice`

### Slice V2C.3F exit gate

- [ ] Early close and scheduled end reject new claims immediately,
  reservations survive and settle, refunds reuse the shared engine with
  server-derived destination and finality-gated terminal state, the F4
  lifecycle passes deterministically, and every gate in Task F5 is green.

---

## Security Review Checklist (Executed Per Slice, Recorded in Slice Commits)

Each slice commit message body records pass or fail for every applicable
line; a failure blocks the commit.

- Owner spoofing: non-owner funder, closer, and publisher attempts rejected
  (A3, A4, F1 suites).
- Claimant spoofing: session wallet versus challenge wallet versus receipt
  wallet mismatches rejected (C2, D2, D4 suites).
- Challenge replay: consumed challenges never verify or reserve twice (C4,
  D1, D5 suites).
- Signature cross-Campaign reuse: Campaign A material never authorizes
  Campaign B (C4, D1 suites).
- Expired challenge: `now() >= expires_at` rejects at verify and inside the
  RPC (C2, C4, D1 suites).
- Nonce reuse: stored hash comparison plus `consumed_at` guard (C1, C2, D1
  suites).
- Creator self-claim: adapter pre-check plus RPC defense-in-depth with
  canonical comparison (D1–D4 suites).
- Capacity races and final-slot race: settlement lock plus expression unique
  index plus check constraint (D1, D5 suites).
- Close-versus-claim race: in-transaction order decides with no torn outcome
  (D5, F1 suites).
- Payout duplicate-send risk: durable attempt, broadcast-start marker,
  no-blind-resend, reconciliation-by-stored-hash (D6, F3 suites).
- Cross-settlement access: binding resolution pins every write to the
  Campaign settlement (A3, D1, F2 suites).
- Public claimant leakage: allowlist equality plus anon-role probes (B1,
  B2, F5 gates).
- Vault leakage: no vault material in any DTO, log, or error (B1, B2, A4,
  F5 audit).
- Session leakage: token hashes never leave the server; own-reads scope to
  the session tuple (B4, E4 suites).
- Client-supplied economics: routes accept identity only; amounts, vaults,
  networks, and refund destinations originate server-side (A4, D4, F2
  suites).
- Client-supplied refund destination: no such parameter exists; audit by
  signature search (F2, F3, F5 gates).
- Funding contract singularity: exactly one callable funding RPC per
  operation with `_settlement_id` first args, zero `_campaign_id`
  invocations for `begin/bind/confirm_reward_funding_atomic` in `src/`
  and `pg_proc`, zero `begin/bind/confirm_campaign_funding_atomic`
  functions, zero `participation_campaign_id` columns on funding rows, and
  no `UPDATE public.reward_campaigns` in any funding RPC body (D1 suite
  plus existing authority audits).

---

## Poll Backward Compatibility Gates

Every slice touching shared code (`settlement-root.ts`,
`reservation-service.ts`, payout, refund, observation, vault) runs these
before its slice commit:

- `npx vitest run src/lib/rewards/v2c1-compatibility.test.ts
  src/lib/rewards/reservation-service.test.ts
  src/lib/rewards/poll-participation-adapter.test.ts
  "src/app/api/polls/[pollId]/vote/route.test.ts"`
- `npx tsx src/lib/api/vote-test.ts`, `npx tsx src/lib/api/v2b1-backward-test.ts`,
  `npx tsx src/lib/api/v2b2-config-test.ts`,
  `npx tsx src/lib/api/v2b2-funding-test.ts` where local services allow.
- Every slice touching funding code additionally runs
  `src/lib/rewards/settlement.test.ts`,
  `src/lib/campaigns/funding.test.ts` (from slice D1 on),
  `src/lib/rewards/funding-confirmation.test.ts`,
  `src/lib/rewards/funding-confirmation.db.test.ts`, and
  `src/lib/rewards/financial-authority-cutover.db.test.ts`, and proves the
  Poll funding routes keep exact request, response, and legacy error
  vocabulary at the boundary (including the confirm-route publicity
  alignment from D1 on).
- Invariants held: free Poll behavior unchanged, legacy_support behavior
  unchanged, rewarded reward_first automatic Claim-free payout unchanged,
  creator votes stay valid votes without rewards, selected-option data never
  enters settlement/receipt/payout/refund/proof/Campaign contracts, one
  wallet one vote preserved, receipt and payout behavior identical, public
  Poll response shapes identical, and Poll funding behavior (begin,
  replay, bind, hash guards, confirmation, finality, response shapes,
  legacy error codes) is identical before and after the D1 contract
  cutover.

---

## Post-Implementation Physical QA — Requires Explicit Human Approval

This section outlines work that is NOT executed by any task above and MUST
NOT run automatically. Real NIM requires human approval before execution.

- [ ] Human approves network, vault, wallets, and the smallest safe test
  amount in writing; approval is recorded before any command runs.
- [ ] Verify exact network (`NIMIQ_NETWORK_ID` value against the target
  network explorer) without sending anything.
- [ ] Verify the exact Campaign vault address from the server readiness
  read against the on-chain account state.
- [ ] Verify the exact creator wallet address from the verified session
  against the intended funding wallet.
- [ ] Fund the smallest safe test amount from the creator wallet through
  the Task A3 routes; confirm server-observed finality in the readiness
  read.
- [ ] Participant opens the share URL, completes challenge, signs, and
  claims; confirm one receipt and reservation-first copy.
- [ ] Confirm real payout broadcast, observation, and Paid proof with
  macro finality.
- [ ] If the Campaign carries an unused remainder, close and confirm the
  server-derived refund with finality.
- [ ] Record transaction hashes, block evidence, and terminal states; then
  stop. No further transfers follow without a new approval.

Real NIM requires human approval before execution. No agent proceeds past
planning on physical QA without that approval.

---

## Plan Self-Review Log

Checked before commit: every spec section maps to plan tasks; no banned
placeholder remains; function, type, and RPC names are consistent across
tasks; migration numbers are sequential after `20260913086000`; each A–F
exit gate exists; Claim UI (E) starts only after atomic backend (D); no
duplicate financial engine is introduced; no other Campaign strategy enters
scope; the frozen database is never an acceptance target; physical NIM is
approval-gated.

Coverage mapping (spec → plan):

- Spec §3 adapter boundary → Tasks D2, D3, D4.
- Spec §4 eligibility → Tasks D1 (authoritative), D2 (pre-check), B1
  (projection), E3 (gating), F4 (lifecycle proof).
- Spec §5 challenges → Tasks C1, C2, C3, C4.
- Spec §6 atomic claim → Tasks D1, D3, D4, D5.
- Spec §7 entitlement/payout → Tasks D6, B4, E2.
- Spec §8 funding → Tasks A1, A2, A3, A4 (resolution, terms, routes,
  readiness; execution deferred) plus Task D1 Phase 1 (shared funding RPC
  contract cutover, generic source resolution, Campaign execution, Poll
  translation, static audits).
- Spec §9 public reads → Tasks B1, B2, B3, B4.
- Spec §10 close/refund → Tasks F1, F2, F3.
- Spec §11 slices → this plan's six slice sections in order.
- Spec §12 deferred → Global Constraints 18, 26, 27 plus B/E/F exclusion
  assertions.
- Spec §13 tests → Tasks C4, D5, D6, E4, F3, F4, F5.
- Spec §14 RLS → Tasks C1, C4, B2, F5.
- Spec §15 Poll compat → Poll gates section plus per-slice regressions.

Issues found and fixed inline:

1. `reward_receipts.campaign_id`, `reward_receipts.poll_id`,
   `reward_funding_transactions.campaign_id`, and
   `reward_refunds.campaign_id` are `NOT NULL` FKs at the current HEAD, so
   spec-compliant reuse is impossible without adaptation. Fixed by adding
   Task D1 migration M2 with the impossibility justification the spec
   requires, instead of inventing a parallel claim table.
2. An early draft resolved Campaign funding through Poll-shaped route
   helpers. Fixed by giving Tasks A2–A3 dedicated Campaign resolution
   (`resolveCampaignRewardSettlement`) that joins only the Campaign binding
   branch.
3. An early draft verified the claim signature inside the reservation RPC.
   Fixed by splitting verification (Task C2 library, Task D4 route,
   pre-mutation) from consumption (M3, same commit as reservation).
4. An early draft exposed the remaining count from a cached projector
   field. Fixed by requiring `loadRewardSettlementContext` derivation on
   every read in Task B1; slice B proves exact reads with zero
   reservations, and live-reservation tracking is proven in Task D1
   Phase 1 and Task D5.
5. An early draft let slice E start alongside slice D. Fixed by making the
   D exit gate an explicit predecessor of every E task.
6. Migration numbering collided with a draft reuse of `20260913` prefixes.
   Fixed with the `20260916` sequence M1–M4 after the shipped maximum,
   ordered by slice execution: M1 challenges in slice C, M2 source
   columns plus M3 claim RPC together in slice D, M4 close and refund in
   slice F. Slice A ships no migration.
8. Sequencing correction: the Campaign-source receipt migration first
   drafted in slice A moved to Task D1 Phase 1 so the migration and the
   atomic reservation behavior that consumes it ship in the same reviewed
   slice; slice A keeps vault usage, funding terms, route contracts,
   delegation proof, and readiness with no receipt or entitlement schema.
9. Shared funding RPC generalization: one `_settlement_id`-canonical
   contract per funding operation with generic Poll/Campaign source
   resolution inside M2, Poll-vocabulary translation in
   `src/lib/rewards/settlement.ts` parsers and the Poll confirm-route
   publicity pre-check, Campaign translation in
   `src/lib/campaigns/funding.ts`, regenerated DB types, catalog static
   audits, and no surviving overload, wrapper, or
   `begin/bind/confirm_campaign_funding_atomic` fork. The as-built slice-A
   resolver location (`src/lib/campaigns/settlement.ts`, keeping the
   shared root Poll-pure per the V2C.1 gate) is recorded in the A2
   interfaces.
7. Placeholder scan: no unfinished-marker abbreviations, no deferred-work
   phrases, no vague-delegation phrasing, and no generic test/validation
   filler appear anywhere in task instructions; every task names exact files, exact function and RPC
   signatures, exact RED/GREEN/regression commands, and an explicit commit
   disposition.

---

## Execution Order and Commit List

- [ ] V2C.3A → `feat(v2c3a): campaign funding and readiness foundation`
  (Tasks A1–A4)
- [ ] V2C.3B → `feat(v2c3b): public campaign read and share-link surface`
  (Tasks B1–B4)
- [ ] V2C.3C → `feat(v2c3c): claim challenge and signature authorization`
  (Tasks C1–C4)
- [ ] V2C.3D → `feat(v2c3d): atomic campaign claim and payout adapter`
  (Tasks D1–D6)
- [ ] V2C.3E → `feat(v2c3e): claim NIM UX and durable status`
  (Tasks E1–E4)
- [ ] V2C.3F → `feat(v2c3f): close refund and vertical slice gate`
  (Tasks F1–F4)
- [ ] Completion → `feat(v2c3): complete Public Giveaway vertical slice`
  (Task F5)

Each commit pushes `origin feat/v2-participation-record` only after its
slice exit gate and the Poll compatibility gates pass. Protected worktree
files (`next.config.ts`, `tsconfig.json`, `.env.local`,
`dev-server-t12.log`, `dev-server-t12.err.log`,
`scripts/seed-device-qa-fixtures.ts`) are never staged.
