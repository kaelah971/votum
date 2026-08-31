# V2B.2 Reward-First Product Alignment Implementation Plan

**Scope:** TDD implementation plan for the design in `docs/superpowers/specs/2026-08-31-v2b2-reward-first-product-alignment-design.md`.

**Execution rule:** For every task, add the failing test or contract assertion first, implement the smallest change that makes it pass, then refactor without changing the contract. This plan does not apply migrations, touch hosted Supabase, send NIM, or start physical QA.

## 1. Guardrails and Baseline

Before changing application code:

- Work only on `feat/v2-participation-record`.
- Do not stage or modify the protected worktree files: `next.config.ts`, `.env.local`, `dev-server-t12.log`, `dev-server-t12.err.log`, and `scripts/seed-device-qa-fixtures.ts`.
- Keep the current branch and `origin/feat/v2-participation-record` history intact.
- Run the existing local-only suites only when their environment is available. Any database command must refuse hosted Supabase URLs.
- Preserve the current V2B.2.4 boundary: intent creation and transaction-hash binding are in scope for compatibility; chain observation, confirmation, payout, and refund execution are not.

Baseline commands:

```text
npm run lint
npx tsc --noEmit
npm test
```

Record the baseline result before the first implementation commit. No baseline result is required for this documentation-only change.

## 2. Task 1 - Add Domain Contracts First

### Tests first

Create `src/lib/polls/economic-model.test.ts` or the repository's equivalent pure contract test with cases for:

- `legacy_support` and `reward_first` are the only economic models;
- `free` and `rewarded` are the only reward-first modes;
- `creator` and `community` are the only funding modes;
- legacy support fields are valid only for the legacy model;
- reward-first rows reject any participant support field;
- rewarded mode requires a reward configuration;
- free mode rejects a reward configuration;
- community funding requires a designated funding wallet;
- creator funding defaults its funding wallet to the creator identity.

### Implementation

- Add a shared domain module for `POLL_ECONOMIC_MODEL`, reward mode, funding mode, and type guards.
- Change `src/types/poll.ts` to a discriminated `PollView` union with impossible support fields on reward-first views.
- Add safe public reward campaign typing where needed without exposing vault key material, session data, or selected-option fields.

### Refactor check

All downstream code must narrow by `economicModel` before reading support fields. Do not use `as` casts to bypass the union.

## 3. Task 2 - Add the Compatibility Migration and RPC Contract

### Tests first

Extend `src/lib/api/v2b2-schema-test.ts` and `src/lib/api/publish-test.ts` with assertions for:

- existing rows classify as `legacy_support` with `reward_mode IS NULL`;
- a reward-first free row stores all legacy support columns as `NULL`;
- a reward-first rewarded row stores all legacy support columns as `NULL`;
- a legacy row with missing support data is rejected;
- a reward-first row with a support field is rejected;
- the current legacy publish argument shape still works;
- the new publish argument shape creates the correct discriminator;
- free publish creates no campaign;
- rewarded publish creates exactly one campaign;
- same idempotency key and same economic payload replay safely;
- same key with changed economic terms returns conflict;
- option validation and rollback remain atomic.

Add these assertions to `src/lib/api/v2b1-backward-test.ts`:

- existing support poll fixtures continue to publish/read;
- existing support rows still expose confirmed support totals;
- one-wallet-one-vote remains unchanged.

### Implementation

Add a migration named `supabase/migrations/20260831160000_v2b2_reward_first_alignment.sql` with this order:

1. Add `polls.economic_model` as `text NOT NULL DEFAULT 'legacy_support'`.
2. Backfill and validate the discriminator for every existing row.
3. Add nullable `polls.reward_mode` and validate the legacy/new combinations.
4. Drop only the physical `NOT NULL` requirement from `mode`, `destination_wallet`, `destination_purpose`, and `min_nim_luna`; do not drop the columns.
5. Add discriminator-aware checks requiring legacy support data on legacy rows and forbidding it on reward-first rows.
6. Add `reward_campaigns.funding_mode` and `funding_wallet`, backfill existing campaigns to creator funding, then enforce their checks.
7. Replace the existing 14-parameter `publish_poll_atomic` overload with a discriminator-aware signature. Preserve old callers through explicit compatibility defaults and keep the current category/format defaults.
8. Preserve service-role-only execution and all existing RLS grants.

Update `src/types/database.ts` to match the migration's generated row, insert, update, and function types. Do not make types nullable without matching database constraints.

### Refactor check

Review the migration for destructive statements. The only allowed existing-column change is loosening nullability so reward-first rows can omit legacy fields. No historical rows, support tables, or reward tables are deleted or rewritten beyond deterministic discriminator backfills.

## 4. Task 3 - Normalize Public Poll Data

### Tests first

Add pure mapping cases around `src/lib/data/public-polls.ts` or a new mapper test for:

- legacy database row -> legacy `PollView` with support fields;
- reward-first free row -> reward-first `PollView` with no support fields;
- reward-first rewarded row -> reward-first view with only the safe reward campaign surface;
- configured/funding-pending campaign -> no public funded offer;
- funded/rewarding campaign -> safe public reward offer;
- malformed discriminator -> fail closed rather than defaulting to creator support;
- public list and detail queries preserve category, format, status, and options.

### Implementation

- Update `src/lib/data/public-polls.ts` to map `economic_model` and `reward_mode` explicitly.
- Load the existing `get_public_reward_campaign` allowlisted surface only for reward-first rewarded polls.
- Keep public query selection narrow for list views.
- Update any poll result, card, creator summary, and receipt serializers that assume support fields are present.

### Refactor check

No public mapper may convert an unknown or reward-first mode into `creator` support by fallback. Unknown values return an unavailable/error state or are omitted according to the existing data-layer convention.

## 5. Task 4 - Migrate Drafts and Create State

### Tests first

Extend `src/app/create/page.test.tsx` and add draft normalization tests covering:

- new draft starts on `decision` and has `reward_first/free` semantics;
- Decision step contains no support labels or inputs;
- Continue moves from Decision to Rewards;
- free mode can reach Review without destination, purpose, minimum NIM, or contribution mode;
- rewarded mode validates reward amount and participant cap;
- community funding validates a designated funding wallet;
- creator funding derives the connected creator wallet on the server rather than trusting request body identity;
- Review shows reward terms and funding source, not participant support terms;
- an old draft with legacy support fields opens in labelled compatibility mode;
- an old draft can preserve/edit/publish its support values;
- a partially filled rewarded draft cannot publish;
- autosave preserves economic model, reward mode, funding mode, and current step.

### Implementation

Update:

- `src/lib/drafts/types.ts`;
- `src/lib/drafts/storage.ts`;
- `src/lib/drafts/usePollDraft.ts`;
- `src/app/create/page.tsx`;
- `src/components/decision/PollReview.tsx`.

Introduce the smallest reusable controls needed for the Rewards step, such as a reward mode selector and funding mode selector. Reuse `validateRewardConfigInput` and the existing display calculations; do not duplicate Luna arithmetic in the UI.

Keep the local storage key readable. Normalize old rows by explicit inference only when the discriminator is absent and legacy support fields are populated. Do not silently convert old support drafts into free polls.

### Refactor check

The normal new draft type must not require placeholder values for `destinationWallet`, `purpose`, `minimumNim`, or `contributionMode`. Compatibility fields may remain in a legacy branch or compatibility type.

## 6. Task 5 - Update Publish Validation and Reward Configuration

### Tests first

Extend `src/lib/api/publish-test.ts` or add route-level tests for:

- verified session required for all publish modes;
- new free payload succeeds without support fields;
- new rewarded creator payload succeeds with server-derived campaign terms;
- new rewarded community payload requires and stores a designated funding wallet;
- new reward-first payload containing any participant support field returns structured validation failure;
- old support payload remains accepted only as legacy compatibility;
- reward fingerprint includes economic model, reward mode, funding mode, wallet, per-participant amount, and cap;
- changing any economic term under the same idempotency key returns conflict;
- a repeated rewarded request does not create a second campaign or vault;
- invalid reward terms never create a campaign;
- free mode never creates a campaign.

Extend `src/lib/api/v2b2-config-test.ts` for:

- creator-only configuration authorization;
- community funding wallet persisted as the designated funder;
- terms lock after funding begins;
- campaign public read model remains allowlisted.

### Implementation

Update `src/app/api/polls/publish/route.ts`:

- validate `economicModel` and `rewardMode`;
- infer legacy only for a concrete old payload or normalized old draft;
- reject support fields on reward-first requests;
- include the economic fields in the idempotency fingerprint;
- pass the new values to the atomic publish RPC;
- create/configure a campaign only for rewarded mode;
- persist `funding_mode` and the canonical designated `funding_wallet`;
- keep the existing vault preparation and non-funded response semantics.

Update `src/app/api/polls/[pollId]/reward/config/route.ts` so a creator may configure funding mode and the designated community wallet while economic terms remain mutable only in `configured` state.

Update `src/lib/rewards/config.ts` only if a shared funding-mode validator is needed. Keep financial terms and fee-reserve arithmetic unchanged.

### Refactor check

The server must derive creator identity from `getVerifiedWalletSession()`. No request-body wallet may choose the creator, campaign owner, or creator refund destination.

## 7. Task 6 - Preserve V2B.2.4 Funding with Creator/Community Authorization

### Tests first

Extend `src/lib/api/v2b2-funding-test.ts` with local-only cases for:

- creator-funded campaign accepts the creator's verified session;
- creator-funded campaign rejects a different wallet;
- community-funded campaign accepts only its designated verified funding wallet;
- community-funded campaign rejects the creator when the creator is not the designated funder;
- request body cannot override campaign, amount, vault, or funding wallet;
- repeated funding intent requests return one authoritative intent;
- binding remains idempotent and rejects a different hash;
- binding remains `funding_pending` and leaves confirmed funding at zero;
- cross-ledger hash reuse remains rejected;
- no receipt, payout, or refund is created.

Keep `src/lib/api/v2b2-vault-test.ts`, `src/lib/rewards/vault-service.test.ts`, `src/lib/rewards/vault-boundary.test.ts`, and the existing reward domain tests in the regression set.

### Implementation

Update:

- `src/app/api/polls/[pollId]/reward/funding/intents/route.ts`;
- `src/app/api/polls/[pollId]/reward/funding/intents/[intentId]/bind/route.ts`;
- the funding RPC migration replacement;
- `src/components/creator/RewardFundingPanel.tsx`;
- funding result/read-model types.

The server checks the session wallet against `reward_campaigns.funding_wallet`. The funding transaction row may retain `creator_wallet` for historical schema compatibility; add a clearly named funder snapshot only if the implementation needs it to make the audit trail truthful, and preserve existing rows.

Do not add chain observation, campaign confirmation, payout, refund, or real funding execution in this task.

### Refactor check

All outward funding shapes expose only the exact amount, vault recipient, memo/reference, and lifecycle state required by the existing V2B.2.4 flow. They never expose private key material or imply confirmation after hash binding.

## 8. Task 7 - Gate Poll UI by the Discriminator

### Tests first

Add component or pure assembly tests covering:

- legacy live poll renders support details and the legacy support panel;
- reward-first free poll renders no support details or support panel;
- reward-first rewarded poll renders only the safe reward status/offer surface;
- configured/funding-pending reward campaign is not advertised as funded;
- reward participation copy never mentions choosing a winning option;
- vote panel remains verified-wallet and one-wallet-one-vote for all models;
- free receipt has no fabricated NIM amount;
- legacy receipt remains unchanged;
- reward receipt types contain no option identifier.

### Implementation

Update:

- `src/components/poll/PollPageView.tsx`;
- `src/components/poll/PollSupportDetails.tsx`;
- `src/components/poll/PollNimSupportPanel.tsx` call sites;
- `src/components/poll/PollVotePanel.tsx` if copy or state assumptions require it;
- `src/components/poll/PollResultPanel.tsx` and receipt assemblies;
- `src/app/polls/[pollId]/page.tsx` and any creator/public page view that assembles these components.

Use a single model guard at the assembly boundary. Do not scatter checks based on null support values, because a missing field alone must not decide whether a poll is legacy.

Update support API routes to reject reward-first polls while leaving legacy support intent, confirmation, results, and mine routes intact.

### Refactor check

Search for every `PollNimSupportPanel`, `PollSupportDetails`, `destinationPurpose`, `destinationWallet`, `minimumNim`, `contributionMode`, and `NIM support` usage. Each use must be classified as legacy-only, reward funding, or general copy before it remains.

## 9. Task 8 - Protect Profile and Creator Metrics

### Tests first

Extend `src/lib/api/v2b1-backward-test.ts`, `src/lib/api/intelligence-test.ts`, and profile tests with:

- support totals still equal confirmed `nim_contributions` for legacy polls;
- reward campaign funding does not increase `nimSupportedLuna`;
- a free poll creates no contribution row;
- `nimEarnedLuna` remains zero before a confirmed paid reward receipt;
- reward campaign metrics cannot expose a selected option;
- creator intelligence still reports existing legacy support totals and votes.

### Implementation

Update profile and creator serializers only where their types now need the economic discriminator. Keep the profile SQL source of truth unchanged for support totals. Add reward-earned aggregation only when a confirmed paid receipt exists in the already defined reward state vocabulary; do not claim payout completion in this alignment release.

### Refactor check

Review every metric label containing `support`, `funded`, `earned`, `paid`, or `NIM`. A campaign funding amount must not be presented as participant support, and a configured campaign must not be presented as funded.

## 10. Task 9 - Rewrite General Copy and Preserve Legacy Copy

### Tests first

Add a copy contract test or static assertion suite that verifies:

- home, metadata, Explore, and How It Works mention free verified polls and funded rewards accurately;
- normal Create labels say `Rewards`, not `Support`;
- no normal new-poll copy asks participants to send NIM;
- legacy support component copy remains available in its scoped surfaces;
- prohibited betting and winner-payout language is absent from new general copy.

### Implementation

Update the affected source and documentation surfaces:

- `src/app/page.tsx`;
- `src/app/layout.tsx`;
- `src/app/how-it-works/page.tsx`;
- `src/components/marketing/HowItWorksTabs.tsx`;
- `src/components/explore/ExploreClient.tsx`;
- `README.md`;
- `DESIGN.md`;
- `docs/brand-messaging.md`;
- `docs/votum-product-idea.md`.

Keep legacy component copy in:

- `src/components/poll/PollNimSupportPanel.tsx`;
- `src/components/poll/PollSupportDetails.tsx`;
- legacy receipt/support result surfaces.

Add explicit legacy labels rather than deleting historical terminology.

### Refactor check

Search the repository for `back`, `support`, `NIM-backed`, `minimum contribution`, and `optional NIM support`. Every remaining occurrence must have a documented scope: general reward-first copy, reward campaign funding, or legacy participant support.

## 11. Task 10 - Regression and Static Verification

### Tests first

Before any broad refactor, add a single alignment regression suite that exercises:

1. Publish free reward-first poll.
2. Read it through the public poll mapper.
3. Cast one verified vote.
4. Attempt a second vote and receive the existing already-voted behavior.
5. Confirm no support intent or contribution row exists.
6. Publish a creator-funded rewarded poll.
7. Confirm campaign configuration is not advertised as funded.
8. Create/bind a local funding intent without observing the chain.
9. Confirm no receipt, payout, refund, or supported-NIM metric was created.
10. Publish/read a legacy support poll and verify support regressions remain green.

### Verification commands

Run, in order:

```text
npm test
npm run lint
npx tsc --noEmit
npm run build
npx tsx src/lib/api/v2b2-schema-test.ts
npx tsx src/lib/api/v2b2-config-test.ts
npx tsx src/lib/api/v2b2-funding-test.ts
npx tsx src/lib/api/v2b1-backward-test.ts
npx tsx src/lib/api/publish-test.ts
```

The database suites must run only against the local Supabase project and clean their fixtures. If local services are unavailable, report the skipped suites rather than substituting a hosted target.

### Physical QA boundary

Do not open Nimiq Pay, create a physical campaign, approve a wallet transaction, send NIM, observe the chain, or begin V2B.2.5. After the implementation and local regressions pass, update `docs/superpowers/reviews/2026-08-23-v2b2-funding-device-qa.md` to reflect the new Rewards step, designated funding wallet, and the still-paused physical approval checkpoint. That later documentation update must not mark any physical check as passed.

## 12. Delivery Order

Implement in this order so each boundary is testable:

1. Domain contracts and discriminated types.
2. Compatibility migration and atomic publish contract.
3. Public poll mapping and safe reward read model.
4. Draft normalization and Create Rewards step.
5. Publish validation and reward campaign configuration.
6. Creator/community funding authorization within V2B.2.4.
7. Poll-page and receipt gating.
8. Profile and creator metric protection.
9. General copy and scoped legacy labels.
10. Full regression, local-only integration suites, build, and QA-document update.

## 13. Definition Of Done

- All Task 1-10 tests pass, including existing support, vote, profile, vault, funding, and publish regression suites.
- New free and rewarded poll payloads never contain participant support fields.
- Legacy support rows and drafts remain readable and publishable through explicit compatibility behavior.
- Reward campaign terms, funding authorization, and public status are server-authoritative.
- No reward record contains selected-option data.
- No profile metric counts reward campaign funding as participant support.
- General copy no longer presents participant-funded support as the normal new-poll path.
- No hosted database, physical wallet approval, NIM transfer, chain observer, payout, or refund operation was started.
- Only intended application, migration, test, and copy files are included in the implementation commits.
