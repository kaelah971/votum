# V2B.2 Reward-First Product Alignment

**Status:** Design specification only. This document does not apply schema changes, change application code, connect a hosted Supabase project, or send NIM.

## 1. Purpose

Votum currently presents participant-funded NIM support as the normal Create and poll-participation model. The product direction is now reward-first:

- New polls are either free verified polls or reward campaigns funded by a creator or a designated community funding wallet.
- A participant never needs to send NIM to vote on a new poll.
- Rewards are for verified participation, never for selecting a particular option.
- The existing participant-support system remains available for historical and explicitly legacy polls.

This design defines the product model, compatibility boundary, UI flow, data contracts, API behavior, copy changes, and testable acceptance criteria for that alignment.

## 2. Locked Decisions

### 2.1 Product behavior

| Decision | Rule |
|---|---|
| New poll economic model | `reward_first` |
| New poll modes | `free` or `rewarded` |
| Free poll participation | Verified wallet, one vote, no participant payment |
| Rewarded participation | Verified wallet, one vote, optional participation reward after campaign funding |
| Reward funding | Creator-funded or designated community-funded |
| Participant-side NIM | Not shown or requested in the normal new-poll path |
| Vote fairness | One verified wallet gets one vote |
| Reward selection | Independent of the selected option |
| Legacy model | Existing participant support remains available only for rows classified as legacy |

### 2.2 Explicit discriminator

The application and database use one explicit economic discriminator. The literal database values are lowercase; the application constants make their meaning unambiguous.

```ts
export const POLL_ECONOMIC_MODEL = {
  LEGACY_SUPPORT_ENABLED: "legacy_support",
  NEW_REWARD_FIRST_POLL: "reward_first",
} as const;
```

The second discriminator is the new poll's reward mode:

```ts
export type RewardFirstMode = "free" | "rewarded";
export type RewardFundingMode = "creator" | "community";
```

`legacy_support` means that the existing support columns and support routes are authoritative. `reward_first` means those columns are absent and must not drive UI, API, or profile behavior.

### 2.3 Reward truthfulness

- A configured or funding-pending campaign is not advertised as funded.
- The public reward read model remains limited to the existing allowlist and only reports an active reward offer in `funded` or `rewarding` states.
- A participant reward is never shown as paid until the future chain-observation and payout work has actually confirmed it.
- V2B.2.5 chain observation, payout, and refund execution remain outside this alignment task.

## 3. Current Repository Evidence

The current implementation has these relevant properties:

- `src/app/create/page.tsx` has `decision -> support -> review` steps and requires `contributionMode`, `purpose`, `destinationWallet`, `minimumNim`, and `duration` before review.
- The same page already contains optional reward fields, but they are nested inside the participant-support step.
- `src/lib/drafts/types.ts` stores the legacy support fields and uses `DraftStep = "decision" | "support" | "review"`.
- `src/app/api/polls/publish/route.ts` validates and fingerprints the legacy support fields, then passes them to `publish_poll_atomic`. Reward configuration is currently optional.
- `supabase/migrations/0001_votum_poll_foundation.sql` makes `mode`, `destination_wallet`, `destination_purpose`, and `min_nim_luna` non-null and restricts `mode` to `creator_support` or `community_support`.
- `supabase/migrations/20260802000000_structured_discovery_foundation.sql` owns the current 14-parameter `publish_poll_atomic` replacement and its category/format defaults.
- `src/types/poll.ts` and `src/lib/data/public-polls.ts` assume every `PollView` has legacy support fields.
- `src/components/poll/PollPageView.tsx` renders `PollSupportDetails` for every live poll that has not been voted on. The participant NIM panel is part of the poll-page assembly path.
- `src/lib/rewards/config.ts`, the reward campaign tables, the vault service, and the V2B.2.4 funding intent/bind routes already provide the creator-reward economic calculations and pre-funding safety boundary.
- Reward records intentionally contain no option or vote-choice field. That privacy rule remains unchanged.
- `20260814000000_v2b1_participant_profiles.sql` calculates `nimSupportedLuna` from confirmed `nim_contributions` and currently returns `nimEarnedLuna` as zero. This must remain truthful.
- Current marketing and product copy still describes NIM-backed votes and optional participant support as the general product, including `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/how-it-works/page.tsx`, `src/components/marketing/HowItWorksTabs.tsx`, `src/components/explore/ExploreClient.tsx`, `README.md`, `DESIGN.md`, `docs/brand-messaging.md`, and `docs/votum-product-idea.md`.

## 4. Target Economic Model

### 4.1 `polls` row contract

Add the following columns without removing any existing column:

| Column | Type | Legacy value | New value |
|---|---|---|---|
| `economic_model` | `text NOT NULL` | `legacy_support` | `reward_first` |
| `reward_mode` | nullable `text` | `NULL` | `free` or `rewarded` |

Existing support columns retain their names and stored values for legacy rows. They become nullable at the physical column level so a new row can omit them, but discriminator-aware checks enforce the logical contract:

- A `legacy_support` row must have a valid existing support mode, destination wallet, destination purpose, and positive minimum amount.
- A `reward_first` row must have `mode`, `destination_wallet`, `destination_purpose`, and `min_nim_luna` all set to `NULL`.
- A `legacy_support` row has `reward_mode IS NULL`.
- A `reward_first` row has `reward_mode IN ('free', 'rewarded')`.
- Existing fairness, status, question, option, category, format, and publication constraints remain in force.

This is a loosening of four existing nullability constraints plus additive discriminator constraints. It is not a drop, rename, rewrite, or backfill of historical economic data.

### 4.2 Reward campaign funding source

Add to `reward_campaigns`:

| Column | Type | Rule |
|---|---|---|
| `funding_mode` | `text NOT NULL` | `creator` or `community` |
| `funding_wallet` | `text NOT NULL` | Canonical designated wallet allowed to fund the campaign |

Existing campaigns backfill to `funding_mode = 'creator'` and `funding_wallet = creator_wallet`. Existing `creator_wallet` remains the immutable campaign owner and refund identity.

For a creator-funded campaign, `funding_wallet` equals `creator_wallet`. For a community-funded campaign, the creator declares a designated community funding wallet. The designated wallet must establish its own verified session before a funding intent can be created or a transaction hash can be bound. The creator cannot impersonate that wallet through request-body fields.

The first release does not model an open-ended pool of anonymous community funders. A campaign has one authoritative funding wallet, which keeps the current exact-amount and idempotent funding-intent design intact.

### 4.3 Campaign relationship

- A new `reward_first/free` poll has no `reward_campaigns` row.
- A new `reward_first/rewarded` poll has exactly one `reward_campaigns` row.
- A legacy poll may retain an existing reward campaign created by prior V2B.2 behavior; it is not deleted or silently reclassified.
- The one-campaign-per-poll unique constraint remains authoritative.
- Reward campaign tables continue to omit `option_id`, selected option, and vote payload data.

## 5. Create Flow

The normal Create stepper becomes:

1. `Decision`
2. `Rewards`
3. `Review`

### 5.1 Decision step

Keep the current decision fields:

- category;
- format;
- question;
- optional context;
- 2-6 unique options.

Remove all economic and participant-payment fields from this step. The continuation label is `Continue to rewards`.

### 5.2 Rewards step

The step begins with a clear choice:

- `Free verified poll`: one verified wallet, one vote, no participant payment, no reward campaign.
- `Reward verified participants`: the creator defines a fixed reward and participant cap.

When rewards are enabled, show:

- `Creator-funded` or `Community-funded` funding mode;
- designated funding wallet for community-funded campaigns;
- reward per participant;
- maximum rewarded participants;
- reward principal;
- estimated fee reserve;
- total required funding;
- poll duration;
- one-wallet-one-vote fairness rule.

The reward settings use `validateRewardConfigInput` as the only financial calculation source. All money is entered as strict NIM decimal strings and stored/transmitted as integer Luna where the existing domain requires it.

The step must not contain:

- contribution mode;
- participant contribution destination;
- contribution purpose;
- minimum participant contribution;
- `Back this choice with NIM` language;
- any control that opens a participant payment transaction.

For a community-funded campaign, copy must identify the wallet as the reward funder, not as a participant destination: `This verified community wallet will fund the reward budget.`

### 5.3 Review step

The review card shows:

- decision category and format;
- question, context, and options;
- participation model: `Free verified poll` or `Rewarded participation`;
- funding mode and designated funding wallet when rewarded;
- reward amount, cap, principal, fee reserve, and total when rewarded;
- duration and closing time;
- `One wallet - one vote`.

The review never shows participant support fields for a normal new draft. Its publish action only prepares the poll publication and, for a rewarded campaign, the existing configured campaign/vault state. It must not imply that the campaign is funded until the funding flow confirms it on-chain.

## 6. Draft and Compatibility Behavior

### 6.1 New drafts

New draft data stores:

```ts
interface RewardFirstDraftFields {
  economicModel: "reward_first";
  rewardMode: "free" | "rewarded";
  rewardFundingMode?: "creator" | "community";
  fundingWallet?: string;
  rewardPerParticipant?: string;
  maxRewardedParticipants?: string;
}
```

The persisted step values become `decision`, `rewards`, and `review`. New drafts do not contain participant support controls or fields.

### 6.2 Existing local drafts

The existing local-storage key remains readable. A draft with populated legacy support fields and no economic discriminator is classified as `legacy_support` during normalization. It opens in an explicit compatibility mode labelled `Legacy support poll` and can preserve/edit/publish its existing support terms.

Compatibility mode is reachable only by opening that existing draft. It is not an option in the normal new-draft flow. The compatibility banner must explain that new polls use rewards or free verified participation.

A draft with an explicit `reward_first` discriminator is normalized to the new Rewards step. Missing reward fields are treated as `free` only when no reward settings exist; a partially populated rewarded draft remains invalid until its reward settings are complete.

### 6.3 Existing published polls

All rows created before the alignment migration are backfilled to `legacy_support`. Their support details, support transactions, public results, creator metrics, and receipts remain readable through the existing paths.

## 7. Poll Participation Surfaces

### 7.1 Legacy poll

The existing behavior remains available:

- show `PollSupportDetails` before voting;
- show `PollNimSupportPanel` only for a legacy poll;
- preserve support intent, confirmation, public support results, and support receipts;
- keep wallet count and NIM support totals separate;
- enforce one verified wallet, one vote.

### 7.2 Free reward-first poll

Show:

- question and context;
- options;
- wallet verification and one-wallet-one-vote rule;
- vote confirmation and verified result.

Do not show:

- participant NIM destination;
- minimum NIM amount;
- NIM support form;
- support result bars;
- any participant payment CTA.

The receipt states that the verified vote was recorded and contains no fabricated NIM amount.

### 7.3 Rewarded reward-first poll

When the campaign is `configured` or `funding_pending`, the public poll must not advertise an active reward. The creator surface may show the exact funding status, vault, principal, fee reserve, and total required funding through the existing creator-only reward surfaces.

When the campaign is `funded` or `rewarding`, the public poll may show:

- reward per eligible participant;
- remaining reward capacity;
- the statement that reward eligibility is independent of option choice;
- the campaign status.

It still never shows a participant payment form. Reward receipt creation and payout must follow the later reward settlement implementation and must not be simulated by this alignment.

### 7.4 Poll data union

`PollView` becomes a discriminated union so support fields cannot be accidentally rendered for reward-first rows:

```ts
type PollView = LegacySupportPollView | RewardFirstPollView;

interface LegacySupportPollView extends PollBase {
  economicModel: "legacy_support";
  rewardMode: null;
  contributionMode: "creator" | "community";
  destinationWallet: string;
  destinationPurpose: string;
  minimumNim: number;
}

interface RewardFirstPollView extends PollBase {
  economicModel: "reward_first";
  rewardMode: "free" | "rewarded";
  contributionMode?: never;
  destinationWallet?: never;
  destinationPurpose?: never;
  minimumNim?: never;
  rewardCampaign?: PublicRewardCampaign;
}
```

The exact shared field extraction may vary with the current type layout, but the discriminator and impossible support fields are mandatory design requirements.

## 8. API and Server Contracts

### 8.1 New publish request

The normal Create flow sends the following shape:

```json
{
  "category": "communities",
  "format": "decision",
  "question": "Which feature should we ship next?",
  "description": null,
  "options": ["A", "B"],
  "economicModel": "reward_first",
  "rewardMode": "free",
  "fairnessMode": "one_wallet_one_vote",
  "duration": "7days",
  "idempotencyKey": "uuid"
}
```

For a rewarded campaign, `rewardMode` is `rewarded` and the request additionally contains:

```json
{
  "reward": {
    "fundingMode": "creator",
    "fundingWallet": "",
    "rewardPerParticipant": "0.01",
    "maxRewardedParticipants": 100
  }
}
```

`fundingWallet` is omitted or empty for creator funding and required for community funding. The server derives the creator identity from the verified session. New reward-first requests containing participant support fields are rejected rather than silently ignored.

### 8.2 Legacy publish request

The server continues accepting the current legacy payload for existing drafts and current persisted callers. It maps that payload to `economicModel = legacy_support`, validates all existing support fields, and preserves the current fingerprint/idempotency behavior.

No new client may select legacy support from the normal Create UI.

### 8.3 Atomic publication

The next migration replaces the current 14-parameter `publish_poll_atomic` signature with a signature that accepts the economic discriminator and reward mode while preserving defaults and an explicit compatibility path for old callers. The migration must drop the old overload only after its replacement is defined, following the pattern already used in `20260802000000_structured_discovery_foundation.sql`.

The RPC must enforce:

- legacy rows contain the support fields;
- reward-first rows contain no support fields;
- free rows do not create a reward campaign;
- rewarded rows create exactly one campaign with immutable validated terms;
- all poll/options/idempotency work remains atomic;
- reward campaign creation and vault preparation remain separate from the poll insert transaction unless the existing route can safely preserve its current failure semantics.

### 8.4 Reward configuration and funding

Update the existing reward routes rather than creating a second reward system:

- reward configuration remains creator-authorized;
- reward terms remain mutable only while campaign state is `configured`;
- creator-funded funding intents require the creator wallet;
- community-funded funding intents require the designated verified funding wallet;
- funding amount and vault recipient remain server-derived;
- hash binding remains idempotent and cross-ledger guarded;
- binding never marks a campaign funded;
- no participant endpoint may create a reward funding intent.

### 8.5 Support route guard

All existing `/api/polls/[pollId]/support/*` routes must reject reward-first polls with a safe domain response. They continue to serve legacy polls without changing their tables, transaction semantics, or confirmation logic.

## 9. Profile, Results, and Receipts

- `nimSupportedLuna` continues to sum confirmed `nim_contributions` only. Reward campaign funding is not participant support and must not increase that field.
- `nimEarnedLuna` remains zero until confirmed reward receipts are actually paid by the later settlement system.
- Free poll voting increments vote participation only.
- Reward campaign funding does not create a vote or support contribution.
- Public results continue to show wallet participation separately from any legacy NIM support or future reward status.
- Legacy receipts retain their NIM-backed support fields.
- Free reward-first receipts contain no NIM amount and no invented transaction reference.
- Reward receipt data remains choice-agnostic and contains no option identifier.

## 10. Copy Direction

### 10.1 New general product copy

Use this direction on the home page, metadata, Explore entry point, and How It Works:

| Surface | Recommended copy |
|---|---|
| Hero | `Verified decisions. Rewards when participation is funded.` |
| Descriptor | `Community decisions for Nimiq Pay.` |
| Explanation | `Create a free verified poll or fund a reward for eligible participants. Every verified wallet gets one vote.` |
| Create CTA | `Create a Votum Poll` |
| Free mode | `Free verified poll` |
| Reward mode | `Reward verified participants` |
| Creator funding | `You fund the reward budget.` |
| Community funding | `A designated community wallet funds the reward budget.` |
| Unfunded state | `Reward campaign configured. Funding is still required before rewards are advertised.` |
| Funded state | `Participants can earn this reward for verified participation, regardless of their choice.` |
| Fairness | `One wallet - one vote` |

The existing brand terms `Votum Poll`, `Votum Result`, and `Votum Receipt` remain valid. `Put NIM behind your say` is no longer a universal product promise; it may remain in clearly labelled legacy-support context or be replaced in general entry-point copy.

### 10.2 Legacy copy

Keep legacy wording in the legacy support panel, legacy compatibility editor, historical support results, and legacy receipts where it accurately describes the stored behavior. Add a small non-promotional `Legacy support` label where needed so an old poll is not mistaken for the normal new model.

### 10.3 Prohibited language

Do not use betting, wagering, odds, pot, jackpot, winner payout, investment, profit, or prediction-market language. Do not describe reward eligibility as payment for choosing an option. Do not call campaign funding participant support.

## 11. Accessibility and Visual Rules

- Use a labelled radio group or equivalent semantic control for free versus rewarded mode and creator versus community funding.
- Keep all existing 44px minimum interaction targets and visible focus states.
- Pair campaign status with text and icon; do not use color alone.
- Announce validation errors at the field and step level.
- Do not make a reward toggle the only indication that a funding transaction is required.
- Keep Signal Gold for the primary action, NIM Blue for proof/information, Verified Green only for confirmed states, and Fairness Amber for pending/review states.
- Keep the existing Soft Fog, Clear Ballot, Ballot Ink, typography, radius, and proof-font system from `DESIGN.md`.

## 12. Acceptance Criteria

The alignment is complete when all of the following are true:

1. A new free poll can be created without entering a participant destination, purpose, minimum contribution, or contribution mode.
2. A new rewarded poll can be created with creator or designated community funding and exact server-derived budget terms.
3. A new poll never renders `PollNimSupportPanel`, `PollSupportDetails`, or a participant NIM payment CTA.
4. A legacy poll still renders its existing support behavior and historical support values.
5. The database discriminator and constraints prevent support fields on reward-first rows.
6. One verified wallet can cast only one vote on both legacy and reward-first polls.
7. Reward terms never include or depend on selected option data.
8. Reward campaign funding remains creator/community-funder authorized, exact-amount, idempotent, and pending until chain confirmation.
9. Profile `nimSupportedLuna` excludes reward campaign funding and `nimEarnedLuna` does not claim unconfirmed payouts.
10. General copy describes verified participation and funded rewards; legacy support copy is scoped to legacy surfaces.
11. Existing support regression, V2B.2 vault/funding safeguards, publish idempotency, and profile privacy tests remain green.
12. No physical funding test is performed during this alignment work.
