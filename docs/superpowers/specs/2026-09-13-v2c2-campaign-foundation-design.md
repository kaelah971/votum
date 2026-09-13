# V2C.2 Campaign Foundation and Generic Settlement Root Design

**Status:** Design specification only. This review patch does not implement
production code, migrations, routes, UI, claim flows, eligibility strategies,
secret storage, allowlist storage, event-proof storage, QR/deep-link behavior,
discovery, NIM transfers, deployment, or creator management.

**Branch:** `feat/v2-participation-record`

**Reviewed commit:** `394ba62 docs(v2c2): design campaign foundation and settlement root`

**Design date:** 2026-09-13

**Primary evidence:**

- `docs/superpowers/reviews/2026-09-12-v2c0-campaign-integration-readiness-audit.md`
- `docs/superpowers/specs/2026-09-12-v2c1-shared-nim-participation-engine-design.md`
- `docs/superpowers/plans/2026-09-13-v2c1-shared-nim-participation-engine-implementation.md`
- `src/lib/nimiq/server-crypto.ts`
- `src/app/api/wallet-proof/challenge/route.ts`
- `src/app/api/wallet-proof/verify/route.ts`
- `src/app/api/polls/publish/route.ts`
- `supabase/migrations/0001_votum_poll_foundation.sql`
- `supabase/migrations/0002_wallet_proof_sessions.sql`
- `supabase/migrations/20260822000000_v2b2_rewarded_participation.sql`
- `supabase/migrations/20260831160000_v2b2_reward_first_alignment.sql`
- V2C.1 completion commit `677d8c4`

## 1. Current-Code Findings

### 1.1 Current product/source records

The current product has Polls, not standalone Campaigns:

| Record | Current authority | V2C.2 treatment |
|---|---|---|
| `polls` | Question, owner, visibility, status, window, economic discriminator, reward mode | Remains the Poll product/source record. No Campaign columns are added. |
| `poll_votes` | Committed verified Poll participation with `poll_id`, `option_id`, and `voter_wallet` | Remains Poll-specific. `option_id` ends at the Poll vote boundary. |
| `poll_options` | Poll option labels and ordering | Remains entirely outside the reward engine. |
| `wallet_challenges` | Generic wallet-proof challenge and single-use consumption | Unchanged in V2C.2. Campaign-bound challenge changes are deferred to V2C.3+. |
| `wallet_sessions` | Hashed session token, wallet identity, expiry, and revocation | Remains shared wallet authentication infrastructure. |

The current Poll path is:

```text
verified wallet session
  -> cast_poll_vote_atomic
  -> PollRewardParticipationAdapter
  -> RewardReservationService
  -> current Poll-compatible reservation RPC
  -> RewardSettlementService
  -> automatic server payout
```

`POST /api/polls/[pollId]/vote` records the vote before reward follow-up work.
Reservation and payout failures do not invalidate a successful vote. This
behavior is a V2C.2 compatibility invariant.

### 1.2 Current financial records

The V2B.2 money engine is safe to reuse, but its physical root is currently
Poll-shaped:

| Record | Current shape | V2C.2 treatment |
|---|---|---|
| `reward_campaigns` | One Poll reward offer; `poll_id uuid NOT NULL UNIQUE REFERENCES polls(id)`; terms, balances, status, and payout lease | Remains the Poll reward adapter. It is not renamed into the Campaign product entity. |
| `reward_campaign_vaults` | One encrypted private vault per `reward_campaigns.id`; service-role only | Remains the single custody record. It receives an additive settlement reference; no key material moves into the root or Campaign table. |
| `reward_funding_transactions` | Funding intent, hash binding, amount/terms snapshot, observation and confirmation fields | Reused by settlement root. Add a settlement reference before cutover; do not immediately rename the existing Poll column. |
| `reward_receipts` | One reward entitlement per campaign and participant wallet, with `poll_id` | Remains the single entitlement ledger. Add a settlement reference; keep the Poll compatibility column temporarily. |
| `reward_payout_attempts` | Durable attempt, signed bytes/hash, broadcast markers, retry state, and finality evidence | Remains attached through the receipt. No second attempt table and no direct source-specific root. |
| `reward_refunds` | Durable refund intent, signed/broadcast fields, and finality evidence | Reused by the generic settlement root with immutable owner/funder refund policy. |

The relevant current database authority is service-role-only and security-
definer. Existing atomic functions lock and reload their own authoritative rows.
The current lower boundary includes funding initiation/confirmation, reservation,
payout preparation/reconciliation/retry, and refund preparation/reconciliation.

### 1.3 V2C.1 status

V2C.1 is complete at `677d8c4`. It added code-level seams but deliberately did
not add Campaign storage:

- `RewardParticipationContext` and `RewardParticipationAdapter` in
  `src/lib/rewards/participation.ts`.
- `PollRewardParticipationAdapter` in
  `src/lib/rewards/poll-participation-adapter.ts`.
- `RewardReservationService` in
  `src/lib/rewards/reservation-service.ts`.
- `RewardSettlementService` in
  `src/lib/rewards/settlement.ts`.
- `RewardClosureService` and `PollRewardClosureAdapter` in
  `src/lib/rewards/closure.ts` and
  `src/lib/rewards/poll-closure-adapter.ts`.

V2C.1 currently treats the physical `reward_campaigns.id` as a compatibility
settlement ID. V2C.2 makes the generic settlement root explicit without
changing the Poll source identity.

### 1.4 Safe reuse boundary

The intended architecture is:

```text
Poll vote or future Campaign claim
  -> source-specific participation/eligibility boundary
  -> generic settlement reservation
  -> one reward receipt
  -> generic payout/finality
  -> generic closure/refund/finality
```

V2C.2 implements only the Campaign product/foundation side of this boundary.
It does not implement the future Campaign claim side.

## 2. Architecture Decision

### 2.1 Locked architecture

Use one first-class Campaign product entity and one generic financial root:

```text
participation_campaigns
  -> reward_settlements
  -> shared funding/reservation/payout/refund engine

polls
  -> reward_campaigns
  -> reward_settlements
  -> the same shared funding/reservation/payout/refund engine
```

`settlement_source_bindings` is a narrow source-to-root relationship record. It
contains no financial terms, balances, vault material, eligibility evidence,
secrets, allowlists, event data, or product presentation.

### 2.2 Decisions

- `participation_campaigns` is the Campaign product/configuration entity.
- `reward_settlements` is the only mutable financial authority after cutover.
- `reward_campaigns` remains the explicit Poll adapter.
- `reward_campaigns.poll_id` remains `NOT NULL`, `UNIQUE`, and FK-enforced.
- Poll and Campaign never share a nullable product mega-row.
- Poll and Campaign use one funding, receipt, payout, reconciliation, vault,
  closure, and refund engine.
- Existing Poll IDs, vote IDs, receipt IDs, funding IDs, payout IDs, refund IDs,
  transaction hashes, and public response aliases remain stable.
- Campaign type literals exist in configuration, but unsupported types cannot be
  published as claimable or enter a participant flow.
- Configuration and funding readiness do not move NIM.

### 2.3 Rejected alternatives

**Generalize `reward_campaigns` directly:** rejected. Making `poll_id` nullable
would weaken the existing FK and turn Poll-specific checks into nullable branches
through every financial function.

**Duplicate the Campaign financial engine:** rejected. Two ledgers would split
hash-reuse, signing, retry, finality, vault, and refund fixes.

**Use a nullable Poll/Campaign mega-table:** rejected. Product configuration,
source evidence, and financial settlement have different authorities and
lifecycle boundaries.

**Continuously dual-write old and new financial tables:** rejected. A
compatibility projection may remain physically for a transition, but it is
historical/read-only after cutover and never an independently mutable ledger.

## 3. Exact Schema Diff

This section defines only the V2C.2 schema. It does not create future claim or
eligibility tables. The implementation must split the target into the ordered
migrations in Section 13.

### 3.1 Verified wallet representation

The repository evidence establishes the canonical representation for new root
and Campaign fields:

- `normalizeAddress()` accepts user-friendly NQ input or hex input and returns
  `Address.toHex()`.
- The wallet challenge route stores the normalized result in
  `wallet_challenges.wallet_address`.
- The wallet verify route stores the signer-derived canonical value in
  `wallet_sessions.wallet_address`.
- The Poll publish route normalizes the verified session before storing
  `polls.creator_wallet`.
- The Poll vote route passes the verified session address to the vote RPC.
- Current reward/vault fixtures generate `"01" + randomBytes(19).toString("hex")`,
  which is 40 lowercase hexadecimal characters.
- `src/lib/rewards/vault-key.test.ts` explicitly asserts
  `/^[0-9a-f]{40}$/` for a generated canonical vault address.

Therefore, the canonical representation produced by the production path is a
lowercase 40-character hexadecimal Nimiq address. However, the existing database
schemas for `polls`, `poll_votes`, `wallet_sessions`, and reward wallet columns
mostly enforce only non-empty `text`. Direct service-role fixtures can therefore
contain historical values that are not database-enforced canonical values.

V2C.2 must not silently rewrite those historical columns. Before root backfill,
an application-side preflight runs `normalizeAddress()` over every relevant
historical identity and checks owner, participant, funder, refund, and vault
relationships. Valid NQ/case/whitespace variants produce a canonical root
snapshot without altering the old source row. Invalid addresses, canonical
collisions, or relationship mismatches block the migration for explicit manual
repair. New root and Campaign rows use the verified lowercase 40-hex invariant.

### 3.2 `reward_settlements`

Create one generic financial root per reward offer. It owns shared terms,
balances, capacity, financial status, payout lease, and accounting after Phase D
cutover. It does not store private vault material or `vault_key_ref`.

```sql
CREATE TABLE public.reward_settlements (
    id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_wallet                 text NOT NULL,
    funding_wallet               text NOT NULL,
    refund_recipient_wallet      text NOT NULL,
    funding_mode                 text NOT NULL DEFAULT 'creator',
    asset                        text NOT NULL DEFAULT 'NIM',
    reward_per_participant_luna bigint NOT NULL,
    max_rewarded_participants   integer NOT NULL,
    reward_principal_luna       bigint NOT NULL,
    fee_reserve_luna            bigint NOT NULL DEFAULT 0,
    total_budget_luna           bigint NOT NULL,
    status                       text NOT NULL DEFAULT 'configured',
    funded_amount_luna           bigint NOT NULL DEFAULT 0,
    refundable_excess_luna       bigint NOT NULL DEFAULT 0,
    rewarded_participant_count   integer NOT NULL DEFAULT 0,
    paid_amount_luna             bigint NOT NULL DEFAULT 0,
    fee_spent_luna               bigint NOT NULL DEFAULT 0,
    refundable_amount_luna       bigint NOT NULL DEFAULT 0,
    first_reservation_at         timestamptz,
    payout_lock_attempt_id       uuid,
    payout_lock_expires_at       timestamptz,
    payout_lock_token            text,
    created_at                   timestamptz NOT NULL DEFAULT now(),
    funded_at                    timestamptz,
    closed_at                    timestamptz,
    refunded_at                  timestamptz,
    updated_at                   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reward_settlements_wallet_shape CHECK (
        owner_wallet = lower(trim(owner_wallet))
        AND funding_wallet = lower(trim(funding_wallet))
        AND refund_recipient_wallet = lower(trim(refund_recipient_wallet))
        AND owner_wallet ~ '^[0-9a-f]{40}$'
        AND funding_wallet ~ '^[0-9a-f]{40}$'
        AND refund_recipient_wallet ~ '^[0-9a-f]{40}$'
    ),
    CONSTRAINT reward_settlements_funding_mode CHECK (
        funding_mode IN ('creator', 'community')
    ),
    CONSTRAINT reward_settlements_creator_funding CHECK (
        funding_mode <> 'creator' OR funding_wallet = owner_wallet
    ),
    CONSTRAINT reward_settlements_refund_destination CHECK (
        refund_recipient_wallet IN (owner_wallet, funding_wallet)
    ),
    CONSTRAINT reward_settlements_asset CHECK (asset = 'NIM'),
    CONSTRAINT reward_settlements_min_reward CHECK (
        reward_per_participant_luna >= 1000
    ),
    CONSTRAINT reward_settlements_max_participants CHECK (
        max_rewarded_participants > 0
    ),
    CONSTRAINT reward_settlements_principal_math CHECK (
        reward_principal_luna =
        reward_per_participant_luna * max_rewarded_participants
    ),
    CONSTRAINT reward_settlements_fee_nonnegative CHECK (fee_reserve_luna >= 0),
    CONSTRAINT reward_settlements_total_math CHECK (
        total_budget_luna = reward_principal_luna + fee_reserve_luna
    ),
    CONSTRAINT reward_settlements_status CHECK (
        status IN ('configured', 'funding_pending', 'funded', 'rewarding',
                   'exhausted', 'closed', 'refunding', 'refunded', 'cancelled')
    ),
    CONSTRAINT reward_settlements_funded_nonnegative CHECK (funded_amount_luna >= 0),
    CONSTRAINT reward_settlements_excess_nonnegative CHECK (refundable_excess_luna >= 0),
    CONSTRAINT reward_settlements_count_range CHECK (
        rewarded_participant_count >= 0
        AND rewarded_participant_count <= max_rewarded_participants
    ),
    CONSTRAINT reward_settlements_paid_nonnegative CHECK (paid_amount_luna >= 0),
    CONSTRAINT reward_settlements_fee_spent_nonnegative CHECK (fee_spent_luna >= 0),
    CONSTRAINT reward_settlements_refundable_nonnegative CHECK (refundable_amount_luna >= 0),
    CONSTRAINT reward_settlements_no_overspend CHECK (
        paid_amount_luna + fee_spent_luna <= funded_amount_luna
    )
);

CREATE INDEX idx_reward_settlements_owner
    ON public.reward_settlements (owner_wallet);
CREATE INDEX idx_reward_settlements_status
    ON public.reward_settlements (status);
CREATE INDEX idx_reward_settlements_status_updated
    ON public.reward_settlements (status, updated_at);
```

The root has no vault address or private key reference. The vault relationship is
resolved through the existing private vault table after its additive settlement
reference is validated.

### 3.3 `participation_campaigns`

Create the Campaign product/configuration entity. It contains no financial
balances, settlement state, vault fields, receipts, payout hashes, or claim
records.

```sql
CREATE TABLE public.participation_campaigns (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    settlement_id                   uuid NOT NULL UNIQUE
        REFERENCES public.reward_settlements(id),
    owner_wallet                    text NOT NULL,
    campaign_type                   text NOT NULL,
    visibility                      text NOT NULL DEFAULT 'unlisted',
    title                           text NOT NULL,
    description                     text,
    status                          text NOT NULL DEFAULT 'draft',
    configuration_version           integer NOT NULL DEFAULT 1,
    published_configuration_version integer,
    starts_at                       timestamptz,
    ends_at                         timestamptz,
    close_reason                    text,
    configuration_locked_at         timestamptz,
    published_at                    timestamptz,
    closed_at                       timestamptz,
    created_at                      timestamptz NOT NULL DEFAULT now(),
    updated_at                      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT participation_campaigns_owner_wallet_shape CHECK (
        owner_wallet = lower(trim(owner_wallet))
        AND owner_wallet ~ '^[0-9a-f]{40}$'
    ),
    CONSTRAINT participation_campaigns_type CHECK (
        campaign_type IN ('public_giveaway', 'secret_drop', 'private_drop',
                          'event_drop', 'community_reward')
    ),
    CONSTRAINT participation_campaigns_visibility CHECK (
        visibility IN ('public', 'unlisted', 'private')
    ),
    CONSTRAINT participation_campaigns_status CHECK (
        status IN ('draft', 'published', 'closed', 'expired', 'cancelled')
    ),
    CONSTRAINT participation_campaigns_title_not_empty CHECK (
        length(trim(title)) BETWEEN 1 AND 160
    ),
    CONSTRAINT participation_campaigns_description_length CHECK (
        description IS NULL OR length(description) <= 4000
    ),
    CONSTRAINT participation_campaigns_version_positive CHECK (
        configuration_version > 0
    ),
    CONSTRAINT participation_campaigns_published_version_valid CHECK (
        published_configuration_version IS NULL
        OR published_configuration_version > 0
    ),
    CONSTRAINT participation_campaigns_window_valid CHECK (
        ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at
    ),
    CONSTRAINT participation_campaigns_close_reason_valid CHECK (
        close_reason IS NULL OR close_reason IN (
            'source_closed', 'elapsed', 'expired', 'creator_cancelled',
            'source_specific'
        )
    )
);

CREATE INDEX idx_participation_campaigns_owner
    ON public.participation_campaigns (owner_wallet);
CREATE INDEX idx_participation_campaigns_type_status
    ON public.participation_campaigns (campaign_type, status);
CREATE INDEX idx_participation_campaigns_public_window
    ON public.participation_campaigns (visibility, status, ends_at);
```

`settlement_id` is created with the Campaign and cannot change after publication.
The owner must match the settlement owner through a server-authoritative atomic
write. There is no stored `claimable` column.

### 3.4 `settlement_source_bindings`

Create a narrow source relationship. The final shape uses two nullable source
FKs only because PostgreSQL needs real foreign keys for the two distinct source
tables; a check constraint permits exactly one branch. This table is not a
polymorphic product/financial mega-table.

```sql
CREATE TABLE public.settlement_source_bindings (
    settlement_id              uuid PRIMARY KEY
        REFERENCES public.reward_settlements(id),
    source_type                text NOT NULL,
    reward_campaign_id         uuid UNIQUE
        REFERENCES public.reward_campaigns(id),
    participation_campaign_id  uuid UNIQUE
        REFERENCES public.participation_campaigns(id),
    created_at                 timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT settlement_source_type CHECK (
        source_type IN ('poll_reward_campaign', 'participation_campaign')
    ),
    CONSTRAINT settlement_source_exactly_one CHECK (
        (source_type = 'poll_reward_campaign'
         AND reward_campaign_id IS NOT NULL
         AND participation_campaign_id IS NULL)
        OR
        (source_type = 'participation_campaign'
         AND reward_campaign_id IS NULL
         AND participation_campaign_id IS NOT NULL)
    )
);
```

The binding write path additionally enforces:

- Poll adapter `reward_campaigns.settlement_id` equals the binding
  `settlement_id`.
- Campaign `participation_campaigns.settlement_id` equals the binding
  `settlement_id`.
- Source owner equals root owner under canonical address comparison.
- A binding cannot change after funding intent, reservation, or any financial
  child row exists.
- A root has exactly one binding and cannot be both a Poll and Campaign source.

The initial Poll-only migration creates the table with the Poll branch. The
Campaign branch and its FK are added only after `participation_campaigns` exists
in the V2C.2C migration.

### 3.5 Additive changes to existing tables

These are staged references, not immediate in-place renames:

```sql
ALTER TABLE public.reward_campaigns
  ADD COLUMN settlement_id uuid REFERENCES public.reward_settlements(id);

ALTER TABLE public.reward_funding_transactions
  ADD COLUMN settlement_id uuid REFERENCES public.reward_settlements(id);

ALTER TABLE public.reward_receipts
  ADD COLUMN settlement_id uuid REFERENCES public.reward_settlements(id);

ALTER TABLE public.reward_refunds
  ADD COLUMN settlement_id uuid REFERENCES public.reward_settlements(id);

ALTER TABLE public.reward_campaign_vaults
  ADD COLUMN settlement_id uuid REFERENCES public.reward_settlements(id);
```

The implementation must then:

1. Backfill each new column from the Poll adapter/root relationship.
2. Validate 100 percent coverage and exact identity relationships.
3. Add the required indexes and `NOT NULL` constraints after validation.
4. Switch services and RPCs to the new settlement columns.
5. Retain old `campaign_id` columns temporarily only as frozen Poll compatibility
   fields where shipped SQL/read models still need them.
6. Remove or deprecate old columns only in a later cleanup after full regression.

`reward_payout_attempts` continues through `reward_receipts`; it does not need a
second direct source column. No claim, secret, allowlist, event-proof, or
community-membership table is created in V2C.2.

## 4. Relationship Model

### 4.1 Poll relationship

The required Poll relationship is:

```text
polls.id
  1 -> 0..1 reward_campaigns.poll_id
reward_campaigns.id
  1 -> 1 reward_campaigns.settlement_id
reward_campaigns.settlement_id
  1 -> 1 reward_settlements.id
```

The source binding represents the same relationship:

```text
reward_campaigns.id
  -> settlement_source_bindings.reward_campaign_id
settlement_source_bindings.settlement_id
  -> reward_settlements.id
```

The Poll resolver must verify:

1. `poll_votes.poll_id` equals the requested Poll ID.
2. `reward_campaigns.poll_id` equals that Poll ID.
3. `reward_campaigns.settlement_id` equals the binding settlement ID.
4. Binding type is `poll_reward_campaign`.
5. Poll owner, adapter owner, and root owner match canonically.
6. Reward eligibility still requires public Poll,
   `economic_model = 'reward_first'`, and `reward_mode = 'rewarded'`.

The Poll adapter reads the source relationship and root identity only. It does
not load root amount, capacity, vault, fee, state, or accounting to establish
source eligibility.

### 4.2 Standalone Campaign relationship

The required Campaign relationship is:

```text
participation_campaigns.id
  1 -> 1 participation_campaigns.settlement_id
participation_campaigns.settlement_id
  1 -> 1 reward_settlements.id
```

The Campaign branch of `settlement_source_bindings` records the same IDs. A
standalone Campaign has no `poll_id` and never creates a `reward_campaigns` row.

### 4.3 Financial child relationship after cutover

```text
reward_settlements
  -> reward_funding_transactions.settlement_id
  -> reward_receipts.settlement_id
       -> reward_payout_attempts.receipt_id
  -> reward_refunds.settlement_id
  -> reward_campaign_vaults.settlement_id
```

During the additive migration, the old `campaign_id` columns remain for
compatibility and are checked against the new settlement ID. After the atomic
authority cutover, new financial writes use only settlement-rooted authority.

### 4.4 Historical Poll preservation

No historical Poll becomes a Campaign. Existing Poll reward rows receive a root
with the same UUID and a Poll binding. Existing vote/option records, reward IDs,
financial hashes, public Poll read shapes, support records, and automatic payout
semantics remain intact.

If a historical wallet value is a valid alternate representation, the preflight
records its canonical equivalent for root matching but leaves the old source
column unchanged. If it is invalid or collides after normalization, backfill
stops for manual repair instead of guessing or rewriting identity.

## 5. Campaign Type Configuration

V2C.2 retains exactly five type literals in `participation_campaigns.campaign_type`.
They are selectable/storable product configuration values, not implemented
eligibility strategies.

| Type | V2C.2 product/configuration state | Deferred capability | V2C.2 readiness |
|---|---|---|---|
| `public_giveaway` | Type, title, visibility, window, root terms, and funding readiness | Claim identity, claim route, reservation, payout, proof, and management slice V2C.3 | Product/configuration foundation ready; claim deferred |
| `secret_drop` | Type can be selected and stored as a draft | Secret verifier/storage and claim flow | Type selectable/storable; strategy deferred |
| `private_drop` | Type can be selected and stored as a draft | Allowlist storage and claim flow | Type selectable/storable; strategy deferred |
| `event_drop` | Type can be selected and stored as a draft | Event proof, QR/deep-link transport, and claim flow | Type selectable/storable; strategy deferred |
| `community_reward` | Type can be selected and stored as a draft | Membership set and claim flow | Type selectable/storable; strategy deferred |

Unsupported types remain non-publishable until their future strategy capability
is registered. They are never treated as claimable merely because their type
literal is present.

### 5.1 Configuration fields

V2C.2 configuration includes:

- owner wallet derived from the verified session;
- type literal;
- title and description;
- public/unlisted/private visibility;
- optional start and end window;
- version and publication lock markers;
- settlement reward amount, participant cap, fee reserve, and total budget;
- designated funding mode and funding wallet;
- deterministic funding readiness, including a valid root, binding, vault
  relationship, and valid integer-Luna terms.

It does not include a strategy-specific secret, allowlist, event proof, QR value,
community member list, claim nonce, claim status, receipt, or participant.

### 5.2 NIM economics configuration

Reuse the current reward economics from `src/lib/rewards/config.ts` and
`src/lib/rewards/constants.ts`:

```text
reward_principal_luna = reward_per_participant_luna * max_participants
fee_reserve_luna      = estimated_fee * max_participants * safety_multiplier
```

The current constants are integer Luna, a 1,000 Luna minimum reward, a 4,000
Luna estimated transaction fee, and a 2x safety multiplier. V2C.2 does not
change that policy. The server derives all values with BigInt; the client cannot
author principal, fee, total, cap, or refund destination.

## 6. Lifecycle State Model

### 6.1 Product lifecycle

`participation_campaigns.status` is product state only:

```text
draft -> published -> closed
                    \-> expired
                    \-> cancelled
```

- `draft`: configuration can change; no participant flow exists.
- `published`: configuration is frozen, subject to funding and future strategy
  gates.
- `closed`: an explicit product/source closure was recorded.
- `expired`: the configured product window elapsed.
- `cancelled`: an owner-authorized product cancellation was recorded.

There is deliberately no stored `claimable` product state and no product
`active` state that duplicates financial status.

### 6.2 Financial lifecycle

`reward_settlements.status` retains the current financial vocabulary:

```text
configured -> funding_pending -> funded -> rewarding -> exhausted
                                       \-> closed -> refunding -> refunded
configured/funded -> cancelled (explicit policy only)
```

Product and financial transitions remain separate:

- `published` does not mean funded.
- `funded` does not mean claimable.
- `closed` does not mean refunded.
- `refunded` requires final chain proof.
- Attempt states remain on funding/payout/refund child rows, not on the product
  Campaign state.

### 6.3 Derived claimability model

The conceptual future read-model predicate is:

```text
claimable =
  product status = published
  AND supported strategy is implemented
  AND current product window permits participation
  AND settlement status is funded or rewarding
  AND settlement capacity remains
```

V2C.2 evaluates this predicate as false for every standalone Campaign because
no Campaign participant claim path or supported strategy is implemented. The
predicate is never persisted as a mutable product state.

### 6.4 Configuration freeze

The existing `first_reservation_at` boundary remains the one-time financial
freeze. Before that boundary, configuration may be edited only within the
allowed product/settlement state. After it, no term affecting owner, funder,
reward amount, cap, fee reserve, refund policy, type, or strategy version can
change. V2C.2 does not implement claims that set this boundary.

## 7. Deferred Claim Identity and Replay Safety

This section is a future design note only. It does not create
`campaign_claims`, modify `wallet_challenges`, add a claim nonce, or enable a
participant flow in V2C.2.

### 7.1 Public Giveaway next slice

V2C.3 must define the first claim identity as:

```text
Campaign ID
  + canonical claimant wallet
  + server-generated random nonce
  + Campaign-bound wallet challenge
  + durable server eligibility decision
```

The future claim record must enforce one canonical wallet claim per Campaign and
must bind challenge purpose, Campaign ID, wallet, nonce, issue time, and expiry.
It must store hashes or opaque identifiers, not raw nonce material.

### 7.2 Replay requirements

Before any claim release, future work must prove:

- nonce consumption is atomic and single-use;
- cross-Campaign, cross-wallet, expired, and malformed replay fails closed;
- replay returns no second receipt or payout attempt;
- duplicate wallet checks happen before capacity can be consumed;
- claim identity is not treated as unique-human identity;
- the reservation service receives only a server-produced minimal participation
  context.

No one of these requirements is implemented by V2C.2.

### 7.3 Wallet challenge extension

The current wallet challenge remains unchanged in V2C.2. Its current message is
for ordinary wallet verification and has no Campaign ID or claim purpose. A
future claim slice may extend the challenge model or add a separate Campaign-
bound challenge record, but must not overload the existing message semantics
without a dedicated migration and regression gate.

## 8. Deferred Eligibility Strategy Boundary

This section records future boundaries without adding their tables or code.

### 8.1 Public Giveaway

The future adapter will use verified wallet identity, Campaign window, settlement
binding, and remaining capacity. The root reservation RPC remains the authority
for amount, capacity, owner, recipient, receipt, and lifecycle transition.

### 8.2 Secret Drop

Future work will add a hash-only secret verifier, generic invalid responses,
Campaign/wallet/IP rate limits, expiry, and replay-safe consumption. No secret
plaintext or verifier storage exists in V2C.2.

### 8.3 Private Drop

Future work will add canonical allowlist import, privacy-safe lookup,
versioning/activation immutability, duplicate handling, and claim integration.
No allowlist storage exists in V2C.2.

### 8.4 Event Drop

Future work will add scoped event proofs, expiry/replay handling, and validated
opaque QR/deep-link transport. No event-proof storage or scanner behavior exists
in V2C.2.

### 8.5 Community Reward

Future work will add an internal server-authoritative membership set. It must
remain distinct from settlement `funding_mode = 'community'`, which only means
the designated funding wallet supplies NIM. No membership storage exists in
V2C.2.

### 8.6 Shared context restriction

All future adapters must return the existing minimal
`RewardParticipationContext` shape. It may contain source identity, canonical
participant/owner identity, server evidence identity, settlement ID, and source
binding. It must not contain amount, capacity, vault, fee, state, accounting,
Poll option data, secret material, allowlist contents, event payloads, or client
booleans.

## 9. Wallet, Session, and Authorization

### 9.1 Actual canonical representation decision

New V2C.2 root and Campaign wallet columns use canonical lowercase 40-character
hex because that is the actual output of `Address.toHex()` used by production
wallet-proof and Poll publish paths, and it is the representation asserted by
current vault tests and generated fixtures.

Existing source columns remain untouched. The preflight described in Section
3.1 is mandatory because current database constraints do not enforce this shape
on all historical Poll/reward values.

The preflight must report at least:

- source row ID and column;
- original value classification: canonical hex, alternate valid Nimiq format,
  or invalid;
- computed canonical value when valid;
- normalized collisions;
- owner/funder/participant mismatch under canonical comparison;
- whether a root snapshot can safely be created.

No automatic rewrite of historical `polls.creator_wallet`,
`poll_votes.voter_wallet`, `wallet_sessions.wallet_address`,
`reward_campaigns` wallet fields, or existing child snapshots is allowed.

### 9.2 Reused identity primitives

Reuse unchanged for ordinary wallet authentication:

- `normalizeAddress` and `addressesEqual`;
- public-key-derived address validation;
- Nimiq signed-message verification;
- single-use generic wallet challenge consumption;
- hashed `wallet_sessions` token, expiry, and revocation;
- connected-wallet mismatch handling.

A verified session authenticates a wallet. It does not establish Campaign
eligibility in V2C.2.

### 9.3 Foundation roles

- **Campaign owner:** verified session wallet matching immutable Campaign/root
  owner; may create and edit a draft through future configuration APIs.
- **Designated funder:** root `funding_wallet`; can later fund through the
  shared funding path. V2C.2 does not initiate or bind a transfer.
- **Participant:** no participant Campaign role exists in V2C.2.
- **Service role:** reads private foundation/financial tables and invokes
  service-role-only atomic functions.

Creator self-claim remains a future reservation rule and must be enforced both
by a future source adapter and the root reservation transition. V2C.2 creates
no self-claim path.

### 9.4 Request restrictions

Future Campaign configuration APIs must derive, not accept, these values:

- owner wallet;
- root/settlement ID;
- financial owner/funder relationship;
- reward amount, cap, fee reserve, total, and refund policy;
- vault address/key material;
- financial state, claimability, receipt status, or chain evidence.

No participant request is accepted in V2C.2.

## 10. Funding Economics and Refund Policy

### 10.1 Funding readiness, not funding execution

V2C.2 may validate funding readiness:

```text
draft Campaign + configured root
  -> valid integer-Luna terms
  -> valid owner/funder policy
  -> valid source/root binding
  -> existing private vault relationship available
  -> ready for a later funding intent
```

It does not create a funding intent, call Nimiq Pay, bind a callback hash,
observe a transaction, confirm funding, or move NIM.

### 10.2 Root economics

All financial values remain integer Luna in PostgreSQL `bigint` and BigInt in
server calculations:

```text
reward_principal_luna = reward_per_participant_luna * max_participants
total_budget_luna     = reward_principal_luna + fee_reserve_luna
```

The client can display formatted NIM but cannot author any trusted amount.

### 10.3 Future shared funding path

The root funding path remains:

```text
verified designated funder
  -> root-derived funding intent
  -> Nimiq Pay transfer to isolated vault
  -> stored callback hash
  -> server observation and finality
  -> exact amount/recipient/network confirmation
  -> settlement status funded
```

Underpayment cannot activate a root. A single confirmed overpayment remains
`refundable_excess_luna`. Additional distinct or unsolicited vault funds are not
credited, spent, or automatically refunded; they require explicit reconciliation
before a funded Campaign can be called safely closed.

### 10.4 Future payout/refund accounting

After root cutover, confirmed payout must atomically advance:

```text
paid_amount_luna += exact confirmed receipt amount
fee_spent_luna  += exact confirmed payout fee
```

The existing safety boundaries remain mandatory: persist signed bytes/hash before
network contact, persist the broadcast-start marker before sending, never blindly
resend hash-bearing uncertainty, allow only bounded hashless pre-broadcast retry,
and require exact canonical/macro-final proof before `paid`.

Future closure/refund must lock the root, block new obligations, block unresolved
reserved/payout-pending/retryable/manual-review work, validate accounting, derive
the immutable refund recipient, and require final chain proof before `refunded`.

Existing Poll refund semantics remain creator-refund semantics during backfill.
New Campaign refund policy must be selected by server policy from owner/funder
identity, persisted before funding, and never selected by a browser.

## 11. Shared Settlement Engine and Poll Adapter

### 11.1 Rooted service boundary

V2C.2 changes the physical authority behind the V2C.1 service names:

```ts
interface RewardSettlementService {
  beginFunding(settlementId: string, funderWallet: string): Promise<unknown>;
  bindFunding(
    settlementId: string,
    intentId: string,
    funderWallet: string,
    transactionHash: string,
  ): Promise<unknown>;
  confirmFunding(
    settlementId: string,
    intentId: string,
    funderWallet: string,
  ): Promise<unknown>;
  executePayout(settlementId: string, receiptId: string): Promise<unknown>;
  reconcilePayout(
    settlementId: string,
    attemptId: string,
    viewerWallet: string,
  ): Promise<unknown>;
}
```

The reservation and closure services retain the V2C.1 context restrictions. All
financial services reload root and child authority server-side; no Campaign
configuration or future strategy can supply financial snapshots.

### 11.2 Poll compatibility path

After root cutover:

```text
POST /api/polls/[pollId]/vote
  -> cast_poll_vote_atomic
  -> PollRewardParticipationAdapter
  -> resolve Poll binding to settlement ID
  -> RewardReservationService
  -> root-backed reservation RPC
  -> RewardSettlementService.executePayout
```

Poll-specific rules remain in Poll adapter/compatibility code:

- public Poll plus `reward_first` plus `rewarded` is required;
- legacy support Polls remain distinct;
- free reward-first Polls create no reward obligation;
- creator votes remain valid votes but are reward-ineligible;
- Poll option data never enters settlement, receipt, payout, refund, or proof;
- valid vote response remains successful if reward follow-up fails;
- automatic payout remains automatic and Claim-free.

### 11.3 Vault authority

`reward_campaign_vaults`, or its later settlement-rooted equivalent, is the only
private vault custody record. It remains service-role-only, encrypted at rest,
and protected by the current vault signing boundary. `reward_settlements` has no
`vault_key_ref`, private key, ciphertext, IV, authentication tag, or duplicate
vault address authority.

The settlement service resolves one vault record by settlement ID and passes key
material only inside `withCampaignVaultKey`. No Campaign configuration API reads
or returns vault secrets.

### 11.4 Campaign participation path is deferred

No Campaign adapter, claim route, receipt reservation, payout execution, or
participant UI is enabled by V2C.2. Public Giveaway is the next vertical slice
and must use this same rooted engine rather than create a parallel path.

## 12. Public/Private Data and RLS

### 12.1 V2C.2 private foundation tables

Enable RLS and revoke `anon` and `authenticated` access for:

- `reward_settlements`;
- `settlement_source_bindings`;
- `participation_campaigns` when returning owner/private configuration;
- all existing financial tables and `reward_campaign_vaults`.

Grant only minimum service-role access needed by server stores and security-
definer transitions. No client directly reads root balances, funding rows,
receipts, attempts, refunds, bindings, or vault rows.

Campaign configuration public reads, if introduced after the foundation, must be
an explicit server read model. It may expose safe Campaign ID/type/title,
visibility, window, product status, and policy-approved funding readiness. It
must not expose private owner management data, root financial internals, vault
material, or unsupported claimability.

### 12.2 Deferred private data

`campaign_claims`, `campaign_secrets`, `campaign_allowlist_entries`, and
`campaign_event_proofs` do not exist in V2C.2. Their future RLS, hashing, privacy,
and error policy must be designed in their respective vertical slices.

No V2C.2 response contains claim nonce material, secret material, allowlist
membership, event proof data, participant data, signed transaction bytes, or
financial chain evidence not already covered by existing Poll compatibility
surfaces.

## 13. Schema Migration and Backfill Order

No migration is implemented by this review patch. The future migrations must be
local, ordered, additive where stated, and guarded by explicit backfill tests.

### 13.1 Required migration order

1. `20260913080000_v2c2_reward_settlements.sql`
   - create `reward_settlements` with root terms, state, balance, accounting,
     owner/funder/refund policy, indexes, RLS, and private grants;
   - do not alter existing Poll or financial rows.
2. `20260913081000_v2c2_poll_settlement_backfill.sql`
   - add nullable staging `reward_campaigns.settlement_id`;
   - create the initial Poll branch of `settlement_source_bindings`;
   - run canonical wallet preflight and fail on invalid/colliding identity;
   - insert one root snapshot per existing `reward_campaigns` row, preserving
     the existing campaign UUID as the root UUID;
   - set each Poll adapter's staging settlement ID;
   - insert and validate exactly one Poll binding per reward campaign;
   - do not switch financial authority.
3. `20260913082000_v2c2_settlement_child_references.sql`
   - add nullable `settlement_id` to funding transactions, receipts, refunds,
     and vaults;
   - backfill each from the validated Poll adapter/root binding;
   - validate 100 percent coverage, cross-row identity, indexes, and hash safety;
   - set `NOT NULL` only after proof;
   - retain old `campaign_id` columns; do not rename in place.
4. `20260913083000_v2c2_participation_campaigns.sql`
   - create `participation_campaigns` with product lifecycle, type literals,
     configuration, owner, window, and one-to-one root FK;
   - add owner/type/window/status indexes and private access controls.
5. `20260913084000_v2c2_campaign_settlement_binding.sql`
   - add the Campaign branch and FK to `settlement_source_bindings`;
   - replace the initial Poll-only check with the final exact-one check;
   - create the Campaign/root consistency guard;
   - prove a root cannot bind to both source types.
6. `20260913085000_v2c2_financial_root_cutover.sql`
   - perform the Phase C root resync immediately before authority switch;
   - update all current funding, reservation, payout, reconciliation, closure,
     refund, and vault-lock RPCs to read/write `reward_settlements` and additive
     `settlement_id` fields only;
   - preserve physical old IDs, hashes, Poll compatibility aliases, and route
     response fields;
   - atomically switch the financial authority under a write-maintenance gate;
   - freeze old `reward_campaigns` financial columns as historical/read-only
     compatibility fields; do not continuously dual-write them.
7. `20260913086000_v2c2_poll_read_root_cutover.sql`
   - move Poll public reward reads and Poll settlement resolution through the
     adapter/binding/root;
   - keep Poll URL and response shapes unchanged;
   - do not expose root private data.

No V2C.2 migration creates future claim, secret, allowlist, event-proof, or
community-membership tables. The future claim challenge migration is not part of
this sequence.

### 13.2 Authority phases

The financial authority transition must be implemented as five explicit phases:

**Phase A - snapshot:** `reward_campaigns` remains the sole financial authority.
`reward_settlements` contains backfilled snapshots only. No service reads a root
value as authoritative yet.

**Phase B - verify:** prove one-to-one root/adapter/binding coverage, canonical
identity mapping, vault mapping, child settlement coverage, transaction hash
uniqueness, and all financial accounting invariants.

**Phase C - resync:** immediately before cutover, while financial writes are
blocked by the deployment/migration gate, lock and resync every root snapshot
from the current authoritative `reward_campaigns` row and validate again. Do not
use a stale Phase A snapshot.

**Phase D - switch:** in one reviewed cutover, change RPCs/services/readers to
`reward_settlements` and additive settlement references as the only financial
authority. A request must not observe mixed old/new mutation authority.

**Phase E - freeze:** retain old `reward_campaigns` financial columns only for
historical/read compatibility where necessary. They are not written, refreshed,
or treated as a second ledger. Existing Poll compatibility reads move to the
root/binding.

### 13.3 Backfill failure policy

- Invalid or ambiguous wallet identity blocks backfill; it is never guessed.
- Normalization collisions block backfill; they are never merged silently.
- Owner, funder, Poll, vault, child-row, or hash mismatch blocks backfill.
- Missing root/adapter/binding coverage blocks cutover.
- Failed pre-cutover migration is rolled back transactionally.
- After cutover, correction uses a forward migration, not destructive reset or
  rollback to dual authority.

## 14. API and Service Contract

V2C.2 plans configuration-only server surfaces. This review patch adds none.

### 14.1 Planned configuration routes

```text
POST /api/campaigns
PATCH /api/campaigns/[campaignId]
POST /api/campaigns/[campaignId]/publish
GET /api/campaigns/[campaignId]/funding-readiness
```

These are future creator configuration/readiness boundaries, not implemented in
V2C.2 review. They may accept title, description, type, visibility, window, and
validated NIM display input. They derive owner/root/binding and financial terms
server-side.

They must not accept or return:

- claim identity or participant data;
- secret, allowlist, event, QR, or community membership data;
- client-selected root ID, owner, funder, vault, recipient, or refund address;
- trusted amount, cap, fee, capacity, state, or claimability;
- NIM transfer hashes or chain proof.

No Campaign close/refund management endpoint is part of V2C.2. Closure/refund
execution remains the later generic financial release gate.

### 14.2 Planned internal modules

- `src/lib/campaigns/types.ts`
  - `ParticipationCampaignType`;
  - `ParticipationCampaignStatus`;
  - `CampaignVisibility`;
  - `CampaignConfiguration`.
- `src/lib/campaigns/configuration.ts`
  - `createParticipationCampaign`;
  - `updateParticipationCampaignDraft`;
  - `publishParticipationCampaign`;
  - `loadCampaignFundingReadiness`.
- `src/lib/rewards/settlement-root.ts`
  - `auditCanonicalWalletRepresentation`;
  - `loadRewardSettlementContext` rooted in `reward_settlements`;
  - `resolvePollRewardSettlement` through Poll adapter/binding;
  - `resolveParticipationCampaignSettlement` through Campaign/binding.
- `src/lib/rewards/settlement.ts`, `reservation-service.ts`, `closure.ts`, and
  funding/payout/refund loaders
  - use settlement ID/root authority after Phase D;
  - retain Poll compatibility aliases only at the outer adapter boundary.

No Campaign claim adapter or eligibility implementation belongs in these modules
for V2C.2.

## 15. Security Threat Model

| Threat | V2C.2 control |
|---|---|
| Two mutable financial authorities | Phase A snapshot, Phase B verification, Phase C resync, atomic Phase D switch, Phase E freeze. No continuous dual-write. |
| Poll/Campaign settlement confusion | Explicit adapter/root IDs, source binding, exact-one check, and cross-row consistency guards. |
| Poll semantic regression | Preserve `reward_campaigns.poll_id NOT NULL UNIQUE`, Poll discriminator checks, automatic payout, and V2C.1E regression gate. |
| Historical wallet ambiguity | Application-side `normalizeAddress` preflight, collision detection, explicit block on invalid data, no silent source rewrite. |
| Client economics forgery | Root derives reward amount, cap, fee, total, funder, vault relationship, and refund policy. |
| Unauthorized Campaign ownership | Owner derives from verified session and is checked against Campaign/root owner on every mutation. |
| Configuration mutation after publication | Product publication lock and `first_reservation_at` financial freeze are server/database authority. |
| Vault key exposure | Existing encrypted vault table and `withCampaignVaultKey`; no root `vault_key_ref` or private key material. |
| Cross-settlement child access | Additive settlement FKs, 100 percent validation, root-scoped loaders, and mismatch rejection. |
| Duplicate funding hash | Existing cross-ledger hash locks and unique indexes remain required after cutover. |
| Duplicate payout send | Existing durable signed bytes/hash, broadcast marker, vault lease, unknown-outcome, and bounded retry rules remain required. |
| False payment/refund proof | Existing server observation, exact transfer checks, canonical inclusion, macro finality, and atomic terminal transition remain required. |
| Public financial leak | RLS, revoked public table grants, and explicit safe read models. |
| Unsupported type presented as usable | Type literals may be stored, but unsupported types cannot publish as claimable or enter participant APIs. |

Deferred future threats include secret brute force, allowlist tampering, event
proof replay, claim nonce replay, and community membership privacy. Those threats
must block their respective vertical slices but do not justify speculative V2C.2
tables.

## 16. TDD Implementation Slices

These are future implementation slices only. This review patch does not execute
them. Each slice uses RED -> GREEN -> refactor and must preserve the current
Poll behavior.

### 16.1 V2C.2A - Settlement root, Poll backfill, and source bindings

**Planned commit:** `feat(v2c2): add settlement root and Poll source bindings`

**Files:**

- Add `supabase/migrations/20260913080000_v2c2_reward_settlements.sql`.
- Add `supabase/migrations/20260913081000_v2c2_poll_settlement_backfill.sql`.
- Add `src/lib/rewards/settlement-root.ts`.
- Add `src/lib/rewards/settlement-root.test.ts`.
- Add `src/lib/rewards/settlement-root.db.test.ts`.
- Regenerate `src/types/database.ts` only from the local resulting schema.

**Symbols:** `auditCanonicalWalletRepresentation`,
`loadRewardSettlementContext`, `resolvePollRewardSettlement`, and the Poll-only
initial binding store.

**RED assertions:**

- `normalizeAddress` evidence and canonical output are recorded in the test.
- Invalid historical wallet values and normalization collisions fail closed.
- Every existing Poll reward row maps to exactly one root with the same UUID.
- Root snapshots preserve terms, accounting, owner, funder policy, and state.
- `reward_campaigns.poll_id` remains required, unique, and FK-enforced.
- Every root has exactly one Poll source binding at the end of the backfill.
- No financial service reads the snapshot as authority before cutover.
- Public roles cannot read root/binding rows.

**GREEN work:** create root snapshots and Poll bindings without changing
financial authority, Poll routes, Poll response shapes, or NIM behavior.

**Commands:**

```text
npm test -- src/lib/rewards/settlement-root.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/rewards/settlement-root.db.test.ts
npx tsc --noEmit
npm run lint
```

### 16.2 V2C.2B - Additive settlement child references

**Planned commit:** `feat(v2c2): add settlement references to financial children`

**Files:**

- Add `supabase/migrations/20260913082000_v2c2_settlement_child_references.sql`.
- Update generated `src/types/database.ts` from local schema.
- Add `src/lib/rewards/settlement-child-compatibility.test.ts`.
- Add `src/lib/rewards/settlement-child-compatibility.db.test.ts`.
- Extend existing funding, reservation, payout, refund, and vault DB tests.

**Symbols:** `backfillSettlementReferences`,
`validateSettlementChildCoverage`, and root-scoped child loaders.

**RED assertions:**

- Nullable `settlement_id` references are additive and initially preserve old
  Poll `campaign_id` columns.
- Funding, receipt, refund, and vault rows have 100 percent settlement coverage.
- Every settlement child agrees with its Poll adapter/root binding.
- Cross-settlement receipt, attempt, funding, refund, and vault lookup fails.
- Existing IDs, hashes, Poll `poll_id`, and compatibility aliases remain stable.
- No child column is renamed or dropped in this slice.
- No migration creates claim/secret/allowlist/event/community tables.

**GREEN work:** add, backfill, index, validate, and then constrain new settlement
references. Do not change the active financial authority.

**Commands:**

```text
npm test -- src/lib/rewards/settlement-child-compatibility.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/rewards/settlement-child-compatibility.db.test.ts
npx tsc --noEmit
npm run lint
```

### 16.3 V2C.2C - Participation Campaign entity and binding

**Planned commit:** `feat(v2c2): add Campaign product entity and root binding`

**Files:**

- Add `supabase/migrations/20260913083000_v2c2_participation_campaigns.sql`.
- Add `supabase/migrations/20260913084000_v2c2_campaign_settlement_binding.sql`.
- Add `src/lib/campaigns/types.ts`.
- Add `src/lib/campaigns/entity.test.ts`.
- Add `src/lib/campaigns/entity.db.test.ts`.

**Symbols:** `ParticipationCampaignType`,
`ParticipationCampaignStatus`, `CampaignVisibility`, and the final exact-one
`settlement_source_bindings` resolver.

**RED assertions:**

- Exactly five type literals are accepted and stored.
- Campaign has a one-to-one root settlement and one source binding.
- Campaign/root owner mismatch fails closed.
- Campaign type, owner, root, and published configuration version cannot change
  after publication.
- No `claimable` product column exists.
- Unsupported types cannot be published as claimable.
- No Poll row is created or modified.
- The Campaign schema contains no claim, secret, allowlist, event, QR, or
  community membership field.

**GREEN work:** add product entity and root binding only. Do not add a Campaign
claim adapter, participant route, eligibility evaluation, or UI.

**Commands:**

```text
npm test -- src/lib/campaigns/entity.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/campaigns/entity.db.test.ts
npx tsc --noEmit
npm run lint
```

### 16.4 V2C.2D - Creator Campaign draft/configuration APIs and NIM economics

**Planned commit:** `feat(v2c2): add Campaign draft and configuration boundary`

**Files:**

- Add `src/lib/campaigns/configuration.ts`.
- Add `src/lib/campaigns/configuration.test.ts`.
- Add `src/lib/campaigns/configuration.db.test.ts`.
- Add configuration route tests for the planned routes only.
- Reuse `src/lib/rewards/config.ts`, constants, and settlement-root stores.

**Symbols:** `createParticipationCampaign`,
`updateParticipationCampaignDraft`, `publishParticipationCampaign`, and
`loadCampaignFundingReadiness`.

**RED assertions:**

- Owner derives only from the verified session.
- Draft configuration validates title, description, type, visibility, and window.
- NIM amount input derives integer-Luna terms through existing reward config.
- Principal, fee reserve, total, funding wallet, refund policy, root, and vault
  are server-authoritative.
- Drafts may change; published configuration cannot change in place.
- Funding readiness does not create a funding intent or move NIM.
- Unsupported types remain non-publishable/non-claimable.
- No claim, strategy, secret, allowlist, event, community, discovery, or UI path
  is added.

**GREEN work:** add configuration-only server boundaries. Do not add creator
financial management, closure/refund management, or participant behavior.

**Commands:**

```text
npm test -- src/lib/campaigns/configuration.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/campaigns/configuration.db.test.ts
npx tsc --noEmit
npm run lint
```

### 16.5 V2C.2E - Atomic financial-authority cutover

**Planned commit:** `feat(v2c2): switch financial authority to settlements`

**Files:**

- Add `supabase/migrations/20260913085000_v2c2_financial_root_cutover.sql`.
- Add `supabase/migrations/20260913086000_v2c2_poll_read_root_cutover.sql`.
- Modify `src/lib/rewards/settlement.ts` and `settlement-root.ts`.
- Modify reservation, funding, payout, reconciliation, closure, refund, and
  vault loaders to use settlement-rooted fields.
- Update Poll route/service tests without changing public Poll paths.
- Add `src/lib/rewards/financial-authority-cutover.db.test.ts`.

**RED assertions:**

- Phase C resync uses current `reward_campaigns` authority immediately before
  the switch.
- Root and child settlement accounting matches at cutover.
- All financial RPCs/services use root fields as the only mutable authority after
  the switch.
- Old `reward_campaigns` financial columns are not refreshed or independently
  mutated after the switch.
- Poll binding still resolves the correct root, never a Poll ID as root ID.
- Existing Poll funding/payout/refund IDs, hashes, and response aliases remain.
- Poll vote response and automatic payout behavior remain unchanged.
- Fee advancement, hash safety, finality, retry, vault lease, closure freeze,
  and refund proof boundaries remain intact.

**GREEN work:** execute the guarded Phase C/D/E cutover and move Poll reads to
root/binding. Do not create any Campaign participant flow.

**Commands:**

```text
npm test -- src/lib/rewards/settlement.test.ts src/lib/rewards/reservation-service.test.ts src/lib/rewards/closure.test.ts src/lib/rewards/v2c1-compatibility.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/rewards/financial-authority-cutover.db.test.ts src/lib/rewards/reservation.db.test.ts src/lib/rewards/funding-confirmation.db.test.ts src/lib/rewards/payout.db.test.ts src/lib/rewards/refund-preparation.db.test.ts src/lib/rewards/refund-reconciliation.db.test.ts
npx tsc --noEmit
npm run lint
```

### 16.6 V2C.2F - Full foundation and migration gate

**Planned commit:** `test(v2c2): verify Campaign foundation and root cutover`

**Files:**

- Add `src/lib/campaigns/v2c2-foundation.test.ts`.
- Add/update only focused compatibility, schema, migration, and Poll route tests
  for demonstrated assertion gaps.

**RED/static assertions:**

- Production schema contains only V2C.2 foundation tables and additive child
  references; no deferred strategy tables exist.
- No claim route, Claim button, participant UI, discovery, NIM transfer, or
  creator financial management is present.
- No `claimable` product state exists.
- No `reward_campaigns.poll_id` nullability change exists.
- No second receipt, payout, refund, or vault ledger exists.
- No old/new financial dual-write remains after cutover.
- Poll history and response behavior remain compatible.
- Root/backfill/canonical-wallet/child coverage is 100 percent.

**Commands:**

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

All DB commands remain local-only and must use
`assertLocalSupabaseForTests()`. A missing local service is reported as skipped,
never replaced with a hosted target.

## 17. Regression and Acceptance Tests

### 17.1 V2C.1 baseline

V2C.2 must retain and rerun the V2C.1 baseline:

- Full Vitest: 57 files and 621 tests passed.
- Focused V2C.1 reward/adapter/closure/financial suites: 11 files and 162 tests
  passed.
- Schema gate: 59 passed.
- Creator configuration gate: 75 passed.
- Funding gate: 57 passed.
- Persisted vault gate: 16 passed.
- V2B.1 backward compatibility: 59 passed.
- Lint, typecheck, and production build passed.

### 17.2 Foundation/schema acceptance

- `reward_settlements`, `participation_campaigns`, and
  `settlement_source_bindings` have the specified constraints and indexes.
- `reward_campaigns.poll_id` remains `NOT NULL UNIQUE` with its Poll FK.
- Root owner/funder/refund policy passes canonical comparisons.
- New root/Campaign wallet fields use lowercase 40-hex canonical storage.
- Historical wallet preflight reports invalid values/collisions and does not
  silently rewrite old source rows.
- Every Poll reward row has one stable root and one Poll binding.
- Every Campaign configuration row has one root and one Campaign binding.
- No root has two source adapters.
- No Campaign table contains financial ledger or vault key authority.
- No claim/secret/allowlist/event/community table exists in V2C.2.

### 17.3 Additive child migration acceptance

- New settlement references are nullable only during the staged backfill.
- 100 percent of funding, receipts, refunds, and vaults have validated root IDs
  before `NOT NULL`/FK enforcement.
- Old `campaign_id` columns remain stable during the additive phase.
- No child UUID, hash, Poll compatibility field, or proof data is rewritten.
- `reward_payout_attempts` remains reached through receipts.
- Cross-settlement child access fails closed.
- Child hash reuse protections remain cross-ledger safe.

### 17.4 Authority cutover acceptance

- Phase A root snapshots are not read as financial authority.
- Phase B proves complete root/binding/child/accounting coverage.
- Phase C resyncs root from current `reward_campaigns` under the cutover gate.
- Phase D switches RPC/service writes to root only.
- Phase E freezes old financial columns; no continuous dual-write remains.
- Poll compatibility reads resolve through adapter/binding/root.
- No request can observe mixed mutable financial authority.

### 17.5 Poll compatibility acceptance

- Poll publication, discovery, voting, receipts, and public reward reads retain
  their current response shapes.
- Legacy support Polls remain distinct.
- Free reward-first Polls create no reward obligation.
- Rewarded reward-first Polls retain automatic reservation and payout.
- Creator votes remain valid Poll votes but do not create reward receipts.
- Exhausted capacity does not invalidate a committed vote.
- Poll option data remains outside shared financial data and proof.
- Reward follow-up failure remains best-effort after vote commit.

### 17.6 Scope acceptance

- No participant claim flow exists.
- No eligibility strategy evaluates a claim.
- No secret, allowlist, event-proof, QR/deep-link, or community membership
  storage exists.
- No Campaign discovery, UI, creator financial management, NIM movement,
  deployment, or physical QA exists.
- Public Giveaway is documented as the next vertical slice.

## 18. Release Gates and Non-Goals

### 18.1 V2C.2 completion means

- Campaign product/configuration entity is defined.
- Generic settlement root is defined and backfilled for Poll reward rows.
- Poll/source bindings are explicit and validated.
- Financial child references are migrated additively before cutover.
- Root becomes the sole mutable financial authority through a guarded switch.
- Old Poll financial columns are frozen/deprecated compatibility fields only.
- Creator draft/configuration and NIM funding-readiness boundaries are defined,
  without NIM movement.
- All five type literals are retained, while unsupported types remain
  non-publishable/non-claimable.
- Public Giveaway remains the next participant vertical slice.

### 18.2 Explicit non-goals

- No `campaign_claims` table or claim route.
- No Campaign-bound claim nonce/challenge migration.
- No `campaign_secrets` table or Secret Drop verifier.
- No `campaign_allowlist_entries` table or Private Drop strategy.
- No `campaign_event_proofs` table or Event Drop proof/QR/deep-link flow.
- No Community Reward membership storage or external integration.
- No participant reservation/payout flow for Campaigns.
- No Campaign discovery, ranking, public proof, or UI.
- No creator financial management, closure, refund, retry, or manual-review UI.
- No NIM transfer, wallet approval, Nimiq Pay flow, physical QA, deployment, or
  `main` merge.
- No betting, prediction market, gambling, winner-takes-pot, or pooled-prize
  semantics.

### 18.3 Later vertical slices

- **V2C.3:** Public Giveaway claim identity, Campaign-bound claim proof,
  reservation, payout, finality, proof, and required management/release gates.
- **Later Secret slice:** Secret Drop hashing, rate limits, verifier, and claim.
- **Later Private slice:** allowlist storage, activation, privacy, and claim.
- **Later Event slice:** event proof, QR/deep-link transport, replay, and device
  validation.
- **Later Community slice:** membership set and claim policy.

No later slice may create a second financial engine or ledger.

## 19. NIM-Centered Proof and Type Readiness

Every Campaign type remains NIM-centered even though V2C.2 does not move NIM:

```text
creator/designated funder configures integer-Luna NIM budget
  -> later funding transfers NIM to an isolated settlement vault
  -> root capacity is bounded by funded principal
  -> later verified participation creates one receipt
  -> vault signs the exact reward transfer
  -> stored hash is observed on Nimiq
  -> exact transfer is canonical and macro-final
  -> receipt becomes paid
  -> unresolved obligations settle before conservative refund
```

| Type | V2C.2 status | Future NIM proof |
|---|---|---|
| Public Giveaway | Product/configuration foundation ready; claim deferred to V2C.3 | Isolated funded vault, exact payout, observed canonical/macro-final transfer, receipt proof |
| Secret Drop | Type selectable/storable; strategy storage and claim deferred | Same funding, payout, finality, and refund proof; secret is only an off-chain unlock |
| Private Drop | Type selectable/storable; allowlist and claim deferred | Same funding and final payout proof; membership is not chain proof |
| Event Drop | Type selectable/storable; proof/QR/deep-link claim deferred | Same funding and finality proof; event transport is not chain proof |
| Community Reward | Type selectable/storable; membership and claim deferred | Same funding and payout proof; membership is not implied by funding mode |

NIM remains central because the root represents a prepaid NIM obligation, capacity
is constrained by funded principal, the isolated vault performs the payout, and
`paid`/`refunded` require observed chain proof. V2C.2 only establishes the
product/root foundation for that later flow.

### Final design verdict

V2C.2 is limited to `participation_campaigns`, `reward_settlements`, explicit
Poll/Campaign source bindings, additive child settlement references, creator
draft/configuration, NIM economics/readiness, Poll compatibility, and a guarded
financial-root cutover. Claim identity, eligibility strategies, strategy storage,
participant flows, creator financial management, and NIM movement remain deferred.
