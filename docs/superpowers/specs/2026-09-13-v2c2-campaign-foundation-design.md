# V2C.2 Campaign Foundation and Generic Settlement Root Design

**Status:** Design specification only. This document does not modify production
code, add migrations, add routes, add Campaign UI, start Docker, mutate
Supabase, send NIM, deploy, or merge `main`.

**Branch:** `feat/v2-participation-record`

**Design date:** 2026-09-13

**Current implementation authority:** The repository at the V2C.1 completion
commit `677d8c4`, the V2C.0 audit, and the V2C.1 specification and implementation
plan listed below.

**Primary documents:**

- `docs/superpowers/reviews/2026-09-12-v2c0-campaign-integration-readiness-audit.md`
- `docs/superpowers/specs/2026-09-12-v2c1-shared-nim-participation-engine-design.md`
- `docs/superpowers/plans/2026-09-13-v2c1-shared-nim-participation-engine-implementation.md`

## 1. Current-Code Findings

### 1.1 Product/source records

The current product has Polls, not standalone Campaigns. The relevant source
records are:

| Record | Current authority | V2C.2 treatment |
|---|---|---|
| `polls` | Question, owner, visibility, status, window, economic discriminator, and reward mode | Remains the Poll product/source record. No Campaign columns are added. |
| `poll_votes` | Committed verified Poll participation with `poll_id`, `option_id`, and `voter_wallet` | Remains Poll-specific. `option_id` ends at the Poll vote boundary and never enters financial records. |
| `poll_options` | Poll option labels and ordering | Remains entirely outside the reward engine. |
| `wallet_challenges` | Five-minute wallet-proof challenge and single-use consumption | Remains shared identity infrastructure; Campaign claims require a Campaign-bound purpose and nonce. |
| `wallet_sessions` | Hashed token, canonical wallet, expiry, and revocation | Remains the server authentication primitive. A session proves wallet control, not Campaign eligibility. |

The Poll vote route is currently:

```text
verified wallet session
  -> cast_poll_vote_atomic
  -> PollRewardParticipationAdapter
  -> RewardReservationService
  -> claim_reward_receipt_atomic compatibility RPC
  -> RewardSettlementService
  -> automatic server payout
```

The vote is committed before reward work. Reservation and payout failures are
best-effort follow-up failures and must not turn a valid vote into a failed vote.

### 1.2 Existing financial records

The V2B.2 tables are real financial records, but they are currently rooted in a
Poll-shaped `reward_campaigns` row:

| Record | Current shape | V2C.2 finding |
|---|---|---|
| `reward_campaigns` | One row per Poll reward offer; `poll_id uuid NOT NULL UNIQUE REFERENCES polls(id)`; terms, balances, status, and payout lease | A Poll reward adapter, not the general Campaign product entity. The `poll_id` constraint remains unchanged. |
| `reward_campaign_vaults` | One private encrypted vault per `reward_campaigns.id`; service-role only | Reused as the custody boundary and re-rooted by settlement identity in the financial cutover. No key material moves into Campaign tables. |
| `reward_funding_transactions` | Funding intent/hash lifecycle and funding terms snapshot | Reused for the one settlement funding path. It must resolve through `reward_settlements` after root cutover. |
| `reward_receipts` | One raw-text wallet entitlement per reward campaign, with a Poll FK | Reused as the single entitlement ledger. Canonical uniqueness becomes a database invariant for Campaigns. |
| `reward_payout_attempts` | Durable signed bytes/hash, broadcast marker, retry state, and finality evidence per receipt | Reused unchanged in safety behavior; lookup becomes settlement-based. |
| `reward_refunds` | Durable creator refund intent, signing/broadcast markers, and finality evidence | Reused for settlement-owner/funder policy; no arbitrary refund destination is accepted. |

The current RPC authority is service-role-only and security-definer. The most
important existing boundaries are:

- `begin_reward_funding_atomic` and `bind_reward_funding_transaction_atomic`
  derive terms, vault, reference, and funding authorization from stored rows.
- `confirm_reward_funding_atomic` confirms only server-observed exact funding
  with the required recipient, amount, network, execution, and finality.
- `claim_reward_receipt_atomic` locks the campaign, reloads Poll and vote
  authority, checks capacity and creator exclusion, inserts the receipt, and
  advances the counter atomically.
- `confirm_reward_payout_atomic` requires exact stored hash, sender, recipient,
  amount, network, successful execution, canonical inclusion, and macro
  finality before `paid`.
- `begin_reward_refund_atomic` blocks unresolved obligations, validates
  accounting, freezes new obligations, and creates one refund intent.
- `confirm_reward_refund_atomic` requires exact server-observed finality before
  the terminal `refunded` state.

### 1.3 V2C.1 implementation boundary

V2C.1 is complete. It added these source-neutral application seams without
adding Campaign storage or changing Poll economics:

- `RewardParticipationContext` and `RewardParticipationAdapter` in
  `src/lib/rewards/participation.ts`.
- `PollRewardParticipationAdapter` in
  `src/lib/rewards/poll-participation-adapter.ts`.
- `RewardReservationService` in
  `src/lib/rewards/reservation-service.ts`.
- `RewardSettlementService` and Poll settlement resolution in
  `src/lib/rewards/settlement.ts`.
- `RewardClosureService` and `PollRewardClosureAdapter` in
  `src/lib/rewards/closure.ts` and
  `src/lib/rewards/poll-closure-adapter.ts`.

The current V2C.1 settlement ID is the physical `reward_campaigns.id`. It is a
compatibility name, not yet a standalone financial root. V2C.2 introduces the
generic root and makes that distinction durable.

### 1.4 Actual readiness conclusion

The safe reuse boundary is below product/source eligibility:

```text
Poll vote or future Campaign claim
  -> source adapter and durable eligibility evidence
  -> generic settlement reservation
  -> one reward receipt
  -> generic payout/finality
  -> generic closure/refund/finality
```

The shared engine must never read `poll_options`, secret plaintext, allowlist
membership, QR contents, or browser-provided economics. It receives only a
server-produced source identity, canonical participant wallet, owner identity,
settlement binding, and durable evidence identity. All money values are reloaded
from the locked settlement row.

## 2. Architecture Decision

### 2.1 Decision

Adopt a first-class `participation_campaigns` product entity and a single
generic `reward_settlements` financial root:

```text
polls
  -> reward_campaigns              Poll financial/product adapter
  -> reward_settlements            shared financial root
  -> reward_funding_transactions
  -> reward_receipts
  -> reward_payout_attempts
  -> reward_refunds

participation_campaigns
  -> reward_settlements            same shared financial root
  -> reward_funding_transactions
  -> reward_receipts
  -> reward_payout_attempts
  -> reward_refunds
```

`settlement_source_bindings` records the source-to-root relationship and
enforces that exactly one source adapter owns a settlement. It contains no
financial terms, eligibility configuration, secrets, or product presentation.

`reward_campaigns` remains the explicit Poll adapter. It is not renamed into
`participation_campaigns`, and its `poll_id NOT NULL UNIQUE` relationship is not
weakened. Existing Poll rows keep their IDs and their existing Poll semantics.

### 2.2 Why this decision

This structure avoids both unsafe alternatives:

- **No direct generalization of `reward_campaigns`:** `poll_id` remains a real
  FK and cannot become nullable. Poll-only constraints do not become branches in
  every financial RPC.
- **No duplicate Campaign engine:** funding, vault custody, payout signing,
  broadcast, observation, finality, retry, receipts, and refunds remain one
  auditable financial path.
- **No nullable polymorphic financial row:** source-specific configuration and
  proof records live in their own tables. The narrow binding table contains only
  a controlled source relationship and has a two-branch check with real FKs.
- **No Poll migration for product naming:** a Poll remains a Poll. The root
  backfill preserves the existing reward campaign ID, transaction hashes,
  receipt IDs, attempt IDs, refund IDs, and Poll response aliases.

### 2.3 Authority split

The authority layers are:

1. `wallet_sessions` proves control of a canonical wallet or authenticated
   operator.
2. A source adapter proves source-specific participation and eligibility from
   durable source data.
3. `settlement_source_bindings` proves which financial root belongs to that
   source adapter.
4. `reward_settlements` owns terms, balances, financial state, capacity, and
   closure freeze under lock.
5. Financial child rows own durable intent, receipt, attempt, and refund proof.
6. Service-role-only security-definer RPCs own atomic state transitions.
7. The Nimiq observation adapter owns chain observation and finality evidence.

No TypeScript interface, Campaign row, or client request is a financial
authority. Every irreversible or terminal transition reloads current rows.

## 3. Exact Schema Diff

This is the target schema, not an executable migration. The implementation must
split it into the ordered migrations in Section 13 and update generated types
from the resulting local schema. All wallet fields below mean canonical
lowercase trimmed Nimiq address strings using the existing server normalization
path. The database must enforce the normalized shape for new Campaign rows.

### 3.1 `reward_settlements`

Create one generic financial root per funded-capable offer. It is the only
authority for shared terms, balances, capacity, and financial lifecycle.

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
    vault_key_ref                text,
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
CREATE INDEX idx_reward_settlements_updated
    ON public.reward_settlements (status, updated_at);
```

The existing state vocabulary is deliberately reused. Product lifecycle values
such as `published` and `expired` do not enter this table.

### 3.2 `participation_campaigns`

Create the product entity. It contains presentation and configuration metadata,
not financial balances, vault fields, receipts, or transaction hashes.

```sql
CREATE TABLE public.participation_campaigns (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    settlement_id              uuid NOT NULL UNIQUE
        REFERENCES public.reward_settlements(id),
    owner_wallet               text NOT NULL,
    campaign_type              text NOT NULL,
    visibility                 text NOT NULL DEFAULT 'unlisted',
    title                      text NOT NULL,
    description                text,
    status                     text NOT NULL DEFAULT 'draft',
    configuration_version      integer NOT NULL DEFAULT 1,
    published_configuration_version integer,
    starts_at                  timestamptz,
    ends_at                    timestamptz,
    close_reason               text,
    configuration_locked_at    timestamptz,
    published_at               timestamptz,
    closed_at                  timestamptz,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),

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

`settlement_id` is created with the product row and cannot be changed after the
Campaign is published. The owner must match the settlement owner through an
atomic server-side transition; a client cannot supply a different settlement.

### 3.3 `campaign_claims`

Create a durable claim-identity and eligibility-proof record. This is not a
second reward ledger. One row represents a Campaign claim attempt/identity; the
single reward receipt remains the financial entitlement.

```sql
CREATE TABLE public.campaign_claims (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id               uuid NOT NULL
        REFERENCES public.participation_campaigns(id),
    claimant_wallet            text NOT NULL,
    claim_nonce_hash           text NOT NULL,
    challenge_id               uuid NOT NULL UNIQUE
        REFERENCES public.wallet_challenges(id),
    evidence_kind              text NOT NULL,
    evidence_digest            text,
    strategy_version           integer NOT NULL,
    status                     text NOT NULL DEFAULT 'issued',
    issued_at                  timestamptz NOT NULL DEFAULT now(),
    expires_at                 timestamptz NOT NULL,
    verified_at                timestamptz,
    consumed_at                timestamptz,
    reward_receipt_id          uuid,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT campaign_claims_wallet_shape CHECK (
        claimant_wallet = lower(trim(claimant_wallet))
        AND claimant_wallet ~ '^[0-9a-f]{40}$'
    ),
    CONSTRAINT campaign_claims_nonce_not_empty CHECK (length(trim(claim_nonce_hash)) > 0),
    CONSTRAINT campaign_claims_evidence_kind CHECK (
        evidence_kind IN ('verified_wallet', 'secret', 'allowlist',
                          'event_proof', 'community_membership')
    ),
    CONSTRAINT campaign_claims_evidence_digest_required CHECK (
        evidence_kind = 'verified_wallet'
        OR (evidence_digest IS NOT NULL AND length(trim(evidence_digest)) > 0)
    ),
    CONSTRAINT campaign_claims_strategy_version_positive CHECK (strategy_version > 0),
    CONSTRAINT campaign_claims_status CHECK (
        status IN ('issued', 'eligible', 'consumed', 'expired', 'rejected')
    ),
    CONSTRAINT campaign_claims_expiry_after_issue CHECK (expires_at > issued_at)
);

CREATE UNIQUE INDEX idx_campaign_claims_campaign_wallet
    ON public.campaign_claims (campaign_id, claimant_wallet);
CREATE UNIQUE INDEX idx_campaign_claims_campaign_nonce
    ON public.campaign_claims (campaign_id, claim_nonce_hash);
CREATE INDEX idx_campaign_claims_expiry
    ON public.campaign_claims (campaign_id, status, expires_at);
```

`reward_receipt_id` is populated only by the shared reservation transition after
the financial schema has been re-rooted. It is never accepted from a browser.
The implementation must add its FK in the migration phase where the generic
receipt relationship exists, avoiding a circular-creation failure.
The claim-write function must also verify that `challenge_id` points to a
`wallet_challenges` row with `purpose = 'campaign_claim'`, the same Campaign ID,
the same nonce hash, and the same canonical wallet; this cross-table invariant
cannot be expressed by the table check constraints alone.

### 3.4 `campaign_allowlist_entries`

Use one versioned, canonical-address table for Private Drop and the initial
internal Community Reward membership set. It is private and service-role
managed.

```sql
CREATE TABLE public.campaign_allowlist_entries (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id               uuid NOT NULL
        REFERENCES public.participation_campaigns(id),
    entry_kind                 text NOT NULL,
    configuration_version      integer NOT NULL,
    wallet_address             text NOT NULL,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    revoked_at                 timestamptz,

    CONSTRAINT campaign_allowlist_kind CHECK (
        entry_kind IN ('private_allowlist', 'community_member')
    ),
    CONSTRAINT campaign_allowlist_version_positive CHECK (configuration_version > 0),
    CONSTRAINT campaign_allowlist_wallet_shape CHECK (
        wallet_address = lower(trim(wallet_address))
        AND wallet_address ~ '^[0-9a-f]{40}$'
    ),
    CONSTRAINT campaign_allowlist_revocation_order CHECK (
        revoked_at IS NULL OR revoked_at >= created_at
    )
);

CREATE UNIQUE INDEX idx_campaign_allowlist_unique_wallet
    ON public.campaign_allowlist_entries
       (campaign_id, entry_kind, configuration_version, wallet_address);
CREATE INDEX idx_campaign_allowlist_lookup
    ON public.campaign_allowlist_entries
       (campaign_id, entry_kind, configuration_version, wallet_address)
    WHERE revoked_at IS NULL;
```

Published configuration versions are immutable. A replacement import creates a
new version, and the Campaign selects that version before publication. Direct
updates/deletes of an activated version are rejected by a trigger or security-
definer write function.

### 3.5 `campaign_secrets`

Store only a strong verifier. A raw secret, code, QR payload, or plaintext
token is never stored.

```sql
CREATE TABLE public.campaign_secrets (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id               uuid NOT NULL
        REFERENCES public.participation_campaigns(id),
    configuration_version      integer NOT NULL,
    digest_scheme              text NOT NULL DEFAULT 'argon2id-v1',
    secret_digest              text NOT NULL,
    max_uses                   integer NOT NULL DEFAULT 1,
    consumed_uses              integer NOT NULL DEFAULT 0,
    status                     text NOT NULL DEFAULT 'active',
    expires_at                 timestamptz,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    revoked_at                 timestamptz,
    updated_at                 timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT campaign_secrets_scheme CHECK (digest_scheme = 'argon2id-v1'),
    CONSTRAINT campaign_secrets_digest_not_empty CHECK (length(trim(secret_digest)) > 0),
    CONSTRAINT campaign_secrets_version_positive CHECK (configuration_version > 0),
    CONSTRAINT campaign_secrets_use_range CHECK (
        max_uses > 0 AND consumed_uses >= 0 AND consumed_uses <= max_uses
    ),
    CONSTRAINT campaign_secrets_status CHECK (
        status IN ('active', 'exhausted', 'revoked', 'expired')
    ),
    CONSTRAINT campaign_secrets_revocation_order CHECK (
        revoked_at IS NULL OR revoked_at >= created_at
    )
);

CREATE UNIQUE INDEX idx_campaign_secrets_digest
    ON public.campaign_secrets (campaign_id, configuration_version, secret_digest);
CREATE INDEX idx_campaign_secrets_active
    ON public.campaign_secrets (campaign_id, configuration_version, status, expires_at);
```

The strategy service performs a constant-time verifier comparison and atomically
consumes usage. It applies wallet, Campaign, and IP rate limits outside the
financial RPC. Invalid secret responses are generic and do not reveal whether a
Campaign, code, or wallet exists.

### 3.6 `campaign_event_proofs`

Model an opaque event activation value for Event Drop. QR and deep-link
transport is a presentation mechanism; the stored value is still a hash.

```sql
CREATE TABLE public.campaign_event_proofs (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id               uuid NOT NULL
        REFERENCES public.participation_campaigns(id),
    configuration_version      integer NOT NULL,
    proof_kind                 text NOT NULL,
    proof_digest               text NOT NULL,
    max_uses                   integer NOT NULL DEFAULT 1,
    consumed_uses              integer NOT NULL DEFAULT 0,
    status                     text NOT NULL DEFAULT 'active',
    starts_at                  timestamptz,
    expires_at                 timestamptz,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    revoked_at                 timestamptz,
    updated_at                 timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT campaign_event_proofs_kind CHECK (
        proof_kind IN ('event_code', 'opaque_link', 'qr_payload')
    ),
    CONSTRAINT campaign_event_proofs_digest_not_empty CHECK (
        length(trim(proof_digest)) > 0
    ),
    CONSTRAINT campaign_event_proofs_version_positive CHECK (configuration_version > 0),
    CONSTRAINT campaign_event_proofs_use_range CHECK (
        max_uses > 0 AND consumed_uses >= 0 AND consumed_uses <= max_uses
    ),
    CONSTRAINT campaign_event_proofs_status CHECK (
        status IN ('active', 'exhausted', 'revoked', 'expired')
    ),
    CONSTRAINT campaign_event_proofs_window_valid CHECK (
        (starts_at IS NULL OR expires_at IS NULL OR expires_at > starts_at)
        AND (revoked_at IS NULL OR revoked_at >= created_at)
    )
);

CREATE UNIQUE INDEX idx_campaign_event_proofs_digest
    ON public.campaign_event_proofs
       (campaign_id, configuration_version, proof_digest);
CREATE INDEX idx_campaign_event_proofs_active
    ON public.campaign_event_proofs
       (campaign_id, configuration_version, status, expires_at);
```

No native scanner API is assumed. Device behavior for Nimiq Pay deep links must
be proven separately before Event Drop is physically QA-ready.

### 3.7 `settlement_source_bindings`

Use a narrow controlled binding table. It is not a Campaign/ Poll mega-table:
it has no title, type configuration, eligibility fields, balances, vault data,
or transaction data. Its two nullable source FKs are constrained so exactly one
real adapter is present.

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

Add a security-definer consistency trigger or write function enforcing:

- `reward_campaigns.settlement_id = settlement_source_bindings.settlement_id`
  for Poll adapters;
- `participation_campaigns.settlement_id = settlement_source_bindings.settlement_id`
  for standalone Campaigns;
- the source owner equals the root owner at creation and publication;
- a binding cannot be changed after the settlement has a funding intent or a
  reservation.

### 3.8 Changes to existing reward tables

The financial root cutover is part of V2C.2 design even though it is not
implemented by this document:

- Add `reward_campaigns.settlement_id uuid REFERENCES reward_settlements(id)`
  as a nullable staging column before the backfill, then set it `NOT NULL` and
  `UNIQUE` only after every existing row is populated. Existing `poll_id uuid
  NOT NULL UNIQUE REFERENCES polls(id)` remains exactly as-is.
- Backfill one `reward_settlements` row for every existing
  `reward_campaigns` row, preserving the existing UUID as the settlement UUID.
  This keeps all shipped Poll `campaignId` aliases stable.
- Re-root `reward_funding_transactions.campaign_id` as
  `settlement_id REFERENCES reward_settlements(id)` without changing intent
  UUIDs, references, hashes, or status values.
- Re-root `reward_receipts.campaign_id` as
  `settlement_id REFERENCES reward_settlements(id)`. Retain `poll_id` as a
  nullable Poll compatibility projection during the first cutover; generic
  services do not use it. A later read-model migration may remove it only after
  all Poll proof consumers are moved to the binding.
- Re-root `reward_refunds.campaign_id` as
  `settlement_id REFERENCES reward_settlements(id)` without changing refund
  UUIDs or chain proof.
- Re-root `reward_campaign_vaults.campaign_id` as
  `settlement_id REFERENCES reward_settlements(id)`. Retain the physical table
  name until all server loaders are migrated; its ciphertext, IV, auth tag, and
  private access rules do not change.
- Resolve `reward_payout_attempts` through the re-rooted receipt. No second
  payout-attempt table is added.
- Retain old financial columns on `reward_campaigns` only as a temporary
  compatibility projection while the RPC and generated-type cutover lands.
  They are not authoritative, are not writable by new code, and must be
  transactionally checked against the root until a later cleanup removes them.
  During the transition, every root financial write refreshes the compatibility
  projection in the same transaction, and any direct divergent write is rejected
  by a consistency guard.

The target state has one root ledger. A temporary compatibility projection is
not a second ledger: every financial mutation is rooted in
`reward_settlements`, and Poll adapter reads are resolved through the root.

### 3.9 Wallet challenge extension required for claims

The current wallet challenge cannot prove a Campaign claim because it has no
Campaign purpose or claim nonce. Before a Campaign claim endpoint exists, add
these fields to `wallet_challenges`:

```sql
ALTER TABLE public.wallet_challenges
  ADD COLUMN purpose text NOT NULL DEFAULT 'wallet_session',
  ADD COLUMN campaign_id uuid REFERENCES public.participation_campaigns(id),
  ADD COLUMN claim_nonce_hash text;

ALTER TABLE public.wallet_challenges
  ADD CONSTRAINT wallet_challenges_campaign_purpose CHECK (
  (purpose = 'wallet_session'
   AND campaign_id IS NULL
   AND claim_nonce_hash IS NULL)
  OR
  (purpose = 'campaign_claim'
   AND campaign_id IS NOT NULL
   AND claim_nonce_hash IS NOT NULL
   AND length(trim(claim_nonce_hash)) > 0)
  );
```

The exact constraint name and migration syntax must follow the repository's
existing migration conventions. Existing wallet-session challenges remain
valid. Campaign challenge messages bind purpose, Campaign ID, canonical wallet,
nonce, domain, issue time, and expiry.

## 4. Relationship Model

### 4.1 Poll relationship

The exact Poll path is:

```text
polls.id
  1 -> 0..1 reward_campaigns.poll_id
  reward_campaigns.id
  1 -> 1 reward_campaigns.settlement_id
  reward_campaigns.settlement_id
  1 -> 1 reward_settlements.id
```

The source binding records the same relationship for generic resolution:

```text
reward_campaigns.id
  -> settlement_source_bindings.reward_campaign_id
settlement_source_bindings.settlement_id
  -> reward_settlements.id
```

The Poll resolver must verify all of these identities before returning a
settlement context:

1. `poll_votes.poll_id` equals the route Poll ID.
2. `reward_campaigns.poll_id` equals that Poll ID.
3. `reward_campaigns.settlement_id` equals the binding settlement ID.
4. The binding source type is `poll_reward_campaign`.
5. Poll owner, adapter owner, and settlement owner match canonically.
6. The Poll is explicitly `economic_model = 'reward_first'` and
   `reward_mode = 'rewarded'` for the reward path.

The Poll adapter reads only source identity and the root binding to establish
eligibility. Amount, capacity, vault, fee, state, and first reservation time are
loaded by the reservation/settlement services from `reward_settlements`.

### 4.2 Standalone Campaign relationship

The exact standalone path is:

```text
participation_campaigns.id
  1 -> 1 participation_campaigns.settlement_id
  participation_campaigns.settlement_id
  1 -> 1 reward_settlements.id
```

The binding records `source_type = 'participation_campaign'` and the same
Campaign/root IDs. A Campaign never obtains a Poll ID as a substitute identity.
There is no `poll_id` column in `participation_campaigns`, and no standalone
Campaign creates a `reward_campaigns` row.

### 4.3 Financial child relationship

After root cutover:

```text
reward_settlements
  -> reward_funding_transactions
  -> reward_receipts
      -> reward_payout_attempts
  -> reward_refunds
  -> reward_campaign_vaults (physical compatibility name)
```

Every child relationship is checked against the requested settlement ID before
any loaded value is used. A receipt, attempt, funding intent, refund, or vault
from another settlement must fail closed.

### 4.4 Historical Poll preservation

No historical Poll is converted into a Campaign. Existing Poll reward campaign
rows receive a root and binding with stable IDs. Existing Poll votes, options,
receipts, payout attempts, funding hashes, refund hashes, automatic payout
behavior, public Poll response shape, and support records remain semantically
unchanged.

The root migration is an identity and authority migration, not a product data
rewrite. Any row that cannot be backfilled with a valid owner, integer-Luna
terms, root state, vault relationship, or Poll binding blocks the migration and
is reported for manual repair; it is never silently guessed.

## 5. Campaign Type Configuration

V2C.2 stores configuration for five types. It does not implement claim flows,
strategy evaluation, Campaign UI, discovery, or payout execution for a
standalone Campaign.

| Type | Product configuration | Eligibility record | What unlocks the shared engine |
|---|---|---|---|
| `public_giveaway` | Public or unlisted presentation, title/description, window, settlement terms | No extra proof row | Verified wallet, available capacity, and a server-created Campaign claim |
| `secret_drop` | Secret-drop window and versioned secret configuration | `campaign_secrets.secret_digest`; no plaintext | Verified wallet plus a server-verified, unexpired, unconsumed secret result |
| `private_drop` | Private visibility and an activated allowlist version | `campaign_allowlist_entries.entry_kind = 'private_allowlist'` | Verified wallet found in the immutable active allowlist version |
| `event_drop` | Event window and event proof version | `campaign_event_proofs` hash; QR/deep link is opaque transport | Verified wallet plus a Campaign-bound, scoped, unexpired event proof |
| `community_reward` | Community visibility and internal membership-set version | `campaign_allowlist_entries.entry_kind = 'community_member'` | Verified wallet found in the server-authoritative membership set |

`funding_mode = 'community'` on a settlement means a designated wallet funds
the budget. It does not mean Community Reward eligibility. The two concepts must
remain separate in storage, APIs, and authorization.

### 5.1 Configuration rules

- A Campaign is created with a settlement in `configured` state and product
  status `draft`.
- Configuration writes are owner-authorized through a verified session and a
  server-side Campaign lookup. The body cannot choose owner, settlement ID,
  vault, current financial state, or balances.
- Publish validates the type-specific configuration and freezes the selected
  `configuration_version`. Published strategy records are immutable.
- Settlement terms are integer Luna and are created through the shared financial
  configuration boundary. The client cannot submit a trusted principal, fee,
  total, capacity, or refund recipient.
- Campaign type is immutable after publication. Changing type requires a new
  Campaign and a new settlement.
- Unsupported or incomplete types remain drafts. They are not represented as
  claimable or funded Campaigns.

## 6. Lifecycle State Model

### 6.1 Product lifecycle

`participation_campaigns.status` is product state only:

```text
draft -> published -> closed
                    \-> expired
                    \-> cancelled
```

- `draft`: configuration may change; no public claim surface exists.
- `published`: configuration is frozen; public/unlisted/private presentation is
  allowed, but claims remain blocked unless the settlement is funded and the
  Campaign-specific strategy is implemented.
- `closed`: owner or source policy closed the Campaign.
- `expired`: the configured Campaign window elapsed and the source adapter
  produced an `expired`/`elapsed` closure reason.
- `cancelled`: owner-authorized cancellation policy completed at the product
  layer; financial refund remains independently observable.

Product state never substitutes for financial state. `published` does not mean
funded, and `closed` does not mean refunded.

### 6.2 Financial lifecycle

`reward_settlements.status` retains the existing V2B.2 vocabulary:

```text
configured -> funding_pending -> funded -> rewarding -> exhausted
                                       \-> closed -> refunding -> refunded
configured/funded -> cancelled (only through an explicit policy)
```

Rules:

- Funding intent is allowed only for a configured root and a designated funder.
- Funding confirmation is the only transition to `funded` and requires chain
  observation/finality.
- First reservation sets `first_reservation_at` exactly once and changes
  `funded` to `rewarding` or `exhausted` under the root lock.
- `rewarding` and `exhausted` are financial states, not Campaign product
  statuses. A product may remain published while a root is exhausted, but no
  new receipt can be created.
- A close trigger freezes new obligations before refund preparation. A closed
  or refunding root cannot accept a new reservation.
- `refunded` requires confirmed refund proof. A product `closed` or `expired`
  row may temporarily point at a root in `closed`, `refunding`, or
  `refunded`.
- Financial attempt states (`submitted`, `pending`, `retryable`, `confirmed`)
  remain on their child rows and are not copied into product Campaign status.

### 6.3 First-reservation configuration freeze

The existing `first_reservation_at` boundary remains the one-time financial
freeze. No Campaign term that affects principal, capacity, fee reserve, refund
policy, owner, funder, type, or strategy version may be changed after it is set.
The database transition, not a browser or stale service snapshot, enforces this.

## 7. Claim Identity and Replay Safety

### 7.1 Claim identity

The identity boundary is:

```text
Campaign ID
  + canonical claimant wallet
  + server-generated random claim nonce
  + Campaign-bound wallet challenge
  + strategy-specific durable evidence
```

`campaign_claims` stores the canonical wallet, a hash of the claim nonce, the
one-time challenge ID, evidence kind/digest, strategy version, and claim state.
It never stores a raw secret, QR payload, browser wallet assertion, reward
amount, vault address, or settlement balance.

The unique financial/product boundary is:

```text
UNIQUE (campaign_id, claimant_wallet)
```

This means one canonical wallet can claim once per Campaign. It does not claim
that a wallet is a unique human or defeat Sybil behavior beyond the declared
one-wallet boundary.

### 7.2 Challenge protocol

The existing generic wallet proof challenge is not reused unchanged. A future
Campaign claim challenge must bind:

```text
purpose = campaign_claim
campaign_id
canonical claimant wallet
random nonce
issue time
expiry
same-origin domain
```

The server creates the nonce, stores only its hash, and creates a challenge
message from those server values. Verification checks the session wallet,
canonical address, public-key-derived address, signature, challenge purpose,
Campaign ID, nonce hash, expiry, and single-use state. Challenge consumption
and claim eligibility transition are atomic.

### 7.3 Replay behavior

- Replaying a consumed nonce returns a generic safe replay result and performs no
  financial mutation.
- Replaying a consumed Campaign claim returns the original safe claim/receipt
  identity only to the same verified wallet where product policy permits; it does
  not create another receipt or payout attempt.
- A second canonical wallet claim is rejected before capacity is evaluated for
  that wallet, preserving replay semantics even after the final slot is taken.
- A stale, expired, cross-Campaign, cross-wallet, malformed, or already-used
  proof fails closed with a non-enumerating error.
- An adapter cannot mark a claim eligible by returning a browser boolean. It
  must create or resolve a durable server claim row.

## 8. Eligibility Strategy Boundary

Each strategy implements a server-only adapter boundary:

```text
verified session wallet
  + Campaign ID
  + untrusted opaque evidence
  -> source-specific validation
  -> durable campaign_claims row
  -> generic RewardParticipationContext
  -> generic reservation
```

### 8.1 Public Giveaway

No secret or allowlist is read. The adapter checks that the Campaign is
published, the window permits a claim, the settlement binding is valid, and the
wallet is verified. The reservation RPC remains the capacity and duplicate
wallet authority.

### 8.2 Secret Drop

The browser submits an opaque code. The strategy:

- applies request-size and syntax limits;
- hashes/verifies against `campaign_secrets.secret_digest` using the configured
  strong verifier;
- binds the code to the Campaign, active configuration version, wallet,
  expiry, and usage policy;
- increments usage or creates the claim atomically;
- returns one generic invalid result for missing, invalid, expired, exhausted,
  or cross-Campaign codes;
- applies wallet, IP, and Campaign rate limits with monitoring.

The code does not choose an amount, recipient, capacity, or settlement.

### 8.3 Private Drop

The strategy canonicalizes the verified wallet and looks up only the active
immutable allowlist version. Imports and writes are service-role-only. Duplicate
addresses are rejected or deterministically deduplicated before activation.
Responses do not reveal whether another wallet is listed.

### 8.4 Event Drop

The browser submits an opaque code/link value. The strategy verifies its hashed
proof, Campaign scope, configuration version, time window, use count, and
replay policy. A QR or deep link contains no financial data and is not treated as
chain proof. Device/Nimiq Pay behavior must be validated separately; no browser
native scanner API is assumed.

### 8.5 Community Reward

The initial strategy is an internal, versioned server membership set using
`campaign_allowlist_entries`. No external contributor integration is invented in
V2C.2. Contributor status is off-chain eligibility evidence; NIM funding and
NIM payout remain separate.

### 8.6 Shared context restriction

The adapter may return only the existing minimal context shape:

```ts
{
  source: { type: "campaign_claim", id: claimId },
  participantWallet,
  ownerWallet,
  eligibility: {
    evidenceId: claimId,
    evidenceKind: "verified_wallet_claim",
    verifiedAt,
  },
  settlement: {
    id: settlementId,
    binding: {
      sourceType: "campaign_claim",
      sourceId: campaignId,
    },
  },
}
```

The context contains no option, secret, allowlist row, event payload, amount,
capacity, vault, fee, state, or balance. The financial service reloads all
financial authority under the settlement lock.

## 9. Wallet, Session, and Authorization

### 9.1 Shared identity reuse

Reuse unchanged where the operation is ordinary wallet authentication:

- `normalizeAddress` and `addressesEqual`.
- Public-key-derived address validation.
- Nimiq wallet signature verification.
- Single-use generic wallet challenge consumption.
- Hashed `wallet_sessions` cookie identity, expiry, and revocation.
- Connected-wallet mismatch handling in the client provider.

These prove wallet control and authenticate a server request. They do not prove
Campaign eligibility without the Campaign-bound claim protocol.

### 9.2 Role boundaries

- **Participant:** verified wallet session matching the claim wallet. Cannot
  choose economics, recipient, owner, settlement, or claim outcome.
- **Campaign owner:** verified wallet matching immutable Campaign and settlement
  owner. May configure before publication and invoke source-specific management
  policy.
- **Designated funder:** verified wallet matching settlement `funding_wallet`.
  May initiate/bind funding. A participant wallet cannot fund through a claim.
- **Refund recipient:** immutable server-derived `refund_recipient_wallet`,
  restricted to the owner or designated funder by settlement policy. It is not a
  body parameter.
- **Service role:** only role allowed to read private financial/configuration
  tables and call atomic financial RPCs.

Creator self-claim remains excluded by default and is checked both in the source
adapter and in the root reservation transition. This is defense in depth, not a
client policy.

### 9.3 Request restrictions

No Campaign endpoint accepts authoritative values for:

- participant or owner wallet;
- settlement/root ID without server binding resolution;
- reward amount, principal, fee, total, capacity, or remaining slots;
- vault address, key reference, sender, or recipient;
- `eligible`, claim status, financial state, or finality evidence;
- Poll option ID or selected-option data;
- refund amount or refund destination.

## 10. Funding Economics and Refund Policy

### 10.1 Integer-Luna economics

All financial values remain integer Luna in database `bigint` columns. The
shared root derives:

```text
reward_principal_luna = reward_per_participant_luna * max_rewarded_participants
total_budget_luna = reward_principal_luna + fee_reserve_luna
```

The server validates safe conversion at JavaScript boundaries and keeps BigInt
for accounting. The browser may display a formatted value but cannot author it.

### 10.2 Funding

The common funding path is:

```text
verified designated funder
  -> settlement funding intent
  -> Nimiq Pay transfer to isolated vault
  -> bind callback hash
  -> server observation
  -> exact recipient/amount/network/finality policy
  -> funded root
```

The intent snapshots root terms and vault recipient. Hash binding is idempotent
and guarded against reuse across funding, support, payout, and refund ledgers.
Underpayment never activates a root.

V2C.2 retains the current conservative excess policy:

- A single confirmed funding transaction may overpay; the difference is stored
  as `refundable_excess_luna`.
- A second distinct funding transaction after confirmation is not credited to
  principal or fee reserve. It is an unresolved/unattributed balance and must
  not be silently spent or automatically promised to a participant.
- Unsolicited vault inflows are not invented as ledger funding and are not
  automatically swept into a creator refund.
- Any unresolved or unobserved balance blocks a production Campaign closure
  decision until an explicit reconciliation/manual-review policy exists.

### 10.3 Payout accounting

The root payout transition must atomically advance both:

```text
paid_amount_luna += confirmed receipt amount
fee_spent_luna  += confirmed payout fee
```

The values are updated only from the stored signed attempt and exact confirmed
chain evidence. A root with mismatched receipt totals, fee totals, or negative
values is not refundable.

The existing safety rules remain mandatory:

- signed bytes and hash persist before network contact;
- `broadcast_started_at` persists before `sendTransaction`;
- hash-bearing or broadcast-started uncertainty is never blindly resent;
- only definite hashless pre-broadcast failure may create a bounded retry;
- `paid` requires exact transfer and canonical macro finality.

### 10.4 Closure and refunds

The source adapter determines whether a Campaign has closed, expired, elapsed,
or been cancelled. The generic closure service then:

1. revalidates the source binding and owner/funder policy;
2. locks the root;
3. blocks new reservations;
4. blocks refund while any `reserved`, `payout_pending`, `retryable`,
   hash-bearing unknown, or manual-review obligation remains unresolved;
5. verifies paid principal and confirmed fee accounting;
6. computes the conservative ledger-known remainder;
7. derives the immutable refund recipient from root policy;
8. creates one refund intent;
9. signs/broadcasts through the existing isolated vault boundary;
10. observes exact sender, recipient, amount, network, execution, canonical
    inclusion, and macro finality;
11. marks the refund confirmed and root `refunded` atomically.

The initial generic policy stores `refund_recipient_wallet` on the root at
creation. New Campaigns use owner refund for creator-funded roots and funder
refund for community-funded roots unless an explicit immutable policy says the
owner receives the remainder. Existing Poll rows preserve their current
creator-refund semantics during backfill. No refund destination is selected by
the browser or by observed chain data.

### 10.5 Fee reserve and excess release gate

No Campaign is called funded, production-ready, or physical-QA-ready unless:

- fee spending is advanced from confirmed payout evidence;
- unresolved payout/retry/manual-review work blocks refund;
- the one-funding/excess policy is represented in the root and management
  surface;
- the vault-balance treatment for unsolicited funds is conservative and
  auditable;
- confirmed refund finality is required before terminal closure.

## 11. Shared Settlement Engine and Poll Adapter

### 11.1 Generic service contracts

V2C.2 changes the financial root behind the V2C.1 service names. The service
boundary remains settlement-ID based:

```ts
interface RewardReservationService {
  reserve(context: RewardParticipationContext): Promise<RewardReservationResult>;
}

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

interface RewardClosureService {
  prepareRefund(
    context: RewardClosureContext,
    authorization: RewardClosureAuthorization,
  ): Promise<unknown>;
  executeRefund(settlementId: string, refundId: string): Promise<unknown>;
}
```

These methods load `reward_settlements`, the private vault, and financial child
rows from server-side stores. No method accepts a Campaign type, secret,
allowlist value, option ID, browser economics, or client finality evidence.

### 11.2 Poll adapter after root cutover

The Poll path remains:

```text
POST /api/polls/[pollId]/vote
  -> existing verified session and cast_poll_vote_atomic
  -> PollRewardParticipationAdapter
  -> Poll binding resolver
  -> RewardReservationService using root settlement ID
  -> RewardSettlementService.executePayout
```

Poll-specific rules stay in the adapter/SQL compatibility boundary:

- only public Polls with `reward_first` and `rewarded` enter the reward path;
- legacy support Polls remain distinct even if a historical reward row exists;
- free reward-first Polls create no financial obligation;
- a creator vote remains a valid vote but is reward-ineligible;
- option identity is not copied into a claim, receipt, payout, refund, or proof;
- a committed vote is not rolled back because reward work fails;
- the route response and automatic payout behavior remain unchanged.

### 11.3 Campaign adapter after V2C.2

V2C.2 defines but does not enable a Campaign claim adapter. A future
`CampaignRewardParticipationAdapter` may resolve a verified `campaign_claims`
row into the same minimal context. It must pass the root ID obtained from the
Campaign binding and never read financial amounts merely to decide eligibility.

There is no Campaign claim route, Claim button, or payout execution in this
design delivery.

## 12. Public/Private Data and RLS

### 12.1 Private tables

Enable RLS and revoke all `anon` and `authenticated` access for:

- `reward_settlements`;
- `settlement_source_bindings`;
- `campaign_claims`;
- `campaign_allowlist_entries`;
- `campaign_secrets`;
- `campaign_event_proofs`;
- `reward_funding_transactions`;
- `reward_receipts`;
- `reward_payout_attempts`;
- `reward_refunds`;
- `reward_campaign_vaults`.

Grant only the minimum service-role operations required by security-definer
RPCs and server-side stores. No browser receives a Supabase table grant for a
private row.

### 12.2 Campaign public read model

If a public Campaign read is added later, it must be an explicit allowlisted
security-definer function or server read model. It may expose only:

- Campaign ID and type;
- safe title/description/visibility;
- product status and configured window;
- safe settlement offer fields such as integer reward amount and remaining
  capacity only when the product policy allows it;
- a truthful funded/available indicator derived from the root.

It must not expose:

- secret digests, allowlist membership, event proof digests, claim nonce hashes;
- vault address when not needed, ciphertext, IV, auth tag, or key reference;
- wallet sessions, challenges, owner authorization details, or internal errors;
- selected Poll option data;
- unsupported chain proof or a claim result for another wallet.

Public reads must not imply that a funded balance proves a claim is eligible or
that a payout hash is final before observation and macro finality.

### 12.3 Error privacy

Secret, allowlist, event, and Campaign existence failures use safe generic
reason classes. Logs may contain internal correlation IDs but not plaintext
secrets, decrypted vault keys, session tokens, or full request bodies.

## 13. Schema Migration and Backfill Order

The implementation must use local, ordered, reviewable migrations. No hosted
Supabase operation or production data mutation belongs in V2C.2 development.

### 13.1 Migration order

The proposed migration files and order are:

1. `20260913080000_v2c2_reward_settlement_root.sql`
   - create `reward_settlements` with exact terms, state, balance, lease,
     wallet, asset, and accounting constraints;
   - create indexes and private grants;
   - do not alter Poll rows.
2. `20260913081000_v2c2_campaign_entity.sql`
   - create `participation_campaigns`;
   - add a nullable staging `reward_campaigns.settlement_id` root FK;
   - create owner/type/status/window constraints and indexes.
3. `20260913082000_v2c2_campaign_eligibility_storage.sql`
   - create `campaign_allowlist_entries`, `campaign_secrets`, and
     `campaign_event_proofs`;
   - add immutable-version and service-role-only guards.
4. `20260913083000_v2c2_campaign_claim_identity.sql`
   - extend `wallet_challenges` with Campaign purpose/nonce fields;
   - create `campaign_claims` and its replay/canonical-wallet indexes;
   - add the `reward_receipt_id` FK only after the generic receipt target is
     available, or add it in the root cutover migration.
5. `20260913084000_v2c2_settlement_source_bindings.sql`
   - create `settlement_source_bindings` with the two real source FKs and exact-
     one check;
   - add binding consistency guards.
6. `20260913085000_v2c2_poll_settlement_backfill.sql`
   - lock and scan existing `reward_campaigns` in deterministic ID order;
   - insert one `reward_settlements` row with the same UUID and copied,
     validated financial values;
   - set `reward_campaigns.settlement_id` to its own preserved ID, then enforce
     `NOT NULL` and `UNIQUE`;
   - insert one Poll binding per row;
   - abort on any mismatch, duplicate, missing owner, invalid state, invalid
     terms, or missing vault relationship;
   - validate row counts and all root/adapter owner and ID relationships.
7. `20260913086000_v2c2_financial_child_root_cutover.sql`
   - re-root funding, receipt, refund, and vault foreign keys to
     `reward_settlements`;
   - preserve existing UUIDs, hashes, Poll compatibility `poll_id`, and
     response aliases;
   - update the atomic RPCs to lock/read/write the root;
   - make root accounting, fee advancement, finality, and refund freeze the
     final authority.
8. `20260913087000_v2c2_public_read_root_cutover.sql`
   - update Poll public reward reads and settlement loaders to join through the
     Poll adapter/binding to the root;
   - expose no new private data;
   - retain Poll URL and response shapes.

The exact timestamps may change only if the repository has a newer migration;
the relative order and one-purpose-per-migration boundary may not change.

### 13.2 Backfill invariants

Before commit, the backfill test must prove:

- every existing `reward_campaigns` row has exactly one root and one Poll
  binding;
- every root backfilled from a Poll has the same stable UUID as its adapter;
- `reward_campaigns.poll_id` remains `NOT NULL`, unique, and FK-enforced;
- no root is bound to both a Poll adapter and a Campaign;
- all owner/funder/refund-wallet values are canonical and policy-valid;
- principal, fee, total, count, paid, fee-spent, funded, and refundable
  accounting passes the root constraints;
- all existing child hashes and IDs remain unique across the same ledgers;
- all existing vault rows map to exactly one root and remain private;
- no historical legacy support or free reward-first Poll becomes eligible;
- no source binding contains an option, vote payload, secret, or amount.

### 13.3 Failure and rollback policy

- A failed pre-backfill migration is rolled back by the migration transaction;
  no partial Campaign root is accepted.
- A backfill mismatch stops the migration and emits the offending stable IDs for
  manual repair. It does not fabricate defaults or delete rows.
- After the financial root cutover, rollback is a forward corrective migration,
  not a destructive database reset. The implementation must not use `git reset`,
  destructive Supabase resets, or a hosted target to bypass a mismatch.
- No Campaign may be published or funded until all root/binding validation and
  local regression gates pass.

## 14. API and Service Contract

V2C.2 designates configuration-only server surfaces. These are planned
boundaries, not implemented routes in this document.

### 14.1 Configuration routes

Planned server-only routes:

```text
POST /api/campaigns
PATCH /api/campaigns/[campaignId]
POST /api/campaigns/[campaignId]/publish
POST /api/campaigns/[campaignId]/close
```

The first three are configuration surfaces. Close only creates a
source closure decision and enters the shared closure service after that service
exists for the generic root; it does not accept refund economics.

The request may contain title, description, type, visibility, window, and
type-specific configuration evidence. The server derives owner from the
verified session and derives or loads the root binding. No request may contain
settlement balances, vault data, claim eligibility, receipt status, payout hash,
or refund destination.

### 14.2 Internal modules

Planned symbols and responsibilities:

- `src/lib/campaigns/types.ts`
  - `ParticipationCampaignType`;
  - `ParticipationCampaignStatus`;
  - `CampaignVisibility`;
  - `CampaignConfiguration`.
- `src/lib/campaigns/configuration.ts`
  - `createParticipationCampaign`;
  - `updateParticipationCampaignDraft`;
  - `publishParticipationCampaign`;
  - `closeParticipationCampaign`.
- `src/lib/campaigns/eligibility-config.ts`
  - type-specific configuration validation only;
  - no claim evaluation and no financial mutation.
- `src/lib/rewards/settlement-root.ts`
  - `loadRewardSettlementContext` rooted in `reward_settlements`;
  - `resolvePollRewardSettlement` through `reward_campaigns` and binding;
  - `resolveParticipationCampaignSettlement` through Campaign and binding.
- `src/lib/rewards/poll-participation-adapter.ts`
  - retain Poll source rules and use the new binding/root resolver.
- `src/lib/rewards/participation.ts`
  - retain the minimal source-neutral context and add no Campaign economics.
- `src/lib/rewards/settlement.ts`, `closure.ts`, `refund-policy.ts`, and the
  payout/funding loaders
  - switch physical financial authority from `reward_campaigns` to the root
    while preserving compatibility method names and outward Poll aliases.

No `CampaignRewardParticipationAdapter` is enabled in V2C.2. Its implementation
belongs to the first funded Campaign vertical slice after the release gates.

### 14.3 Response rules

Configuration responses may return safe Campaign product data and a public
Campaign ID. They must not return claim nonce material, digest material, private
membership, vault ciphertext, session tokens, signed bytes, or unsupported
financial proof. Existing Poll funding, voting, payout, refund, and public
reward response shapes remain compatible.

## 15. Security Threat Model

| Threat | Required control |
|---|---|
| Duplicate wallet claims | Database-enforced canonical `(campaign_id, claimant_wallet)` uniqueness plus root-lock reservation replay. |
| Claim nonce replay | Campaign-bound challenge, hashed nonce, atomic single-use consumption, expiry, and claim status transition. |
| Secret brute force | Strong hash-only verifier, generic errors, request limits, wallet/IP/Campaign rate limits, monitoring, and no existence oracle. |
| Allowlist tampering | Service-role-only writes, canonical unique addresses, immutable activated version, import validation, and audit logging. |
| QR/deep-link reuse | Hashed proof, Campaign/version scope, expiry, use limit, wallet binding, and explicit replay policy. |
| Creator self-claim | Immutable root/Campaign owner comparison in both adapter and reservation RPC. |
| Capacity race | Root row lock, replay-before-capacity, atomic receipt insert/counter/status transition, and final-slot concurrency tests. |
| Client economics forgery | All amount, fee, capacity, owner, funder, vault, and refund values loaded server-side from root rows. |
| Settlement confusion | Root ID plus source binding checked on every loader and RPC; Poll ID never substitutes for settlement ID. |
| Duplicate funding hash | Existing cross-ledger hash locks and partial unique indexes retained after root cutover. |
| Duplicate payout send | Signed bytes/hash persisted before broadcast, broadcast-start marker, vault lease, no resend after uncertainty, bounded hashless retry. |
| False payment proof | Sole observation adapter plus exact sender/recipient/amount/network/execution/canonical/macro-finality checks before `paid`. |
| Refund race | Root closure lock, unresolved-obligation block, accounting validation, refund freeze triggers, and finality-gated terminal state. |
| Vault key exposure | Existing encrypted-at-rest envelope and `withCampaignVaultKey` transient scope; no Campaign table contains key material. |
| Private data leak | RLS, revoked public grants, explicit read allowlists, generic errors, and no public strategy rows. |
| Poll semantic regression | `reward_campaigns.poll_id NOT NULL UNIQUE`, explicit Poll discriminator checks, unchanged vote route, automatic payout, and V2C.1E gate. |
| Fake product readiness | Draft/incomplete types are not claimable, funded, discoverable as available, or represented by fake UI. |

## 16. TDD Implementation Slices

Each slice is planned RED -> GREEN -> refactor. The slices below are a future
implementation plan only. They must not be executed as part of this design-only
delivery.

### 16.1 V2C.2A - Root schema and Poll backfill

**Planned commit:** `feat(v2c2): add generic settlement root and Poll bindings`

**Files:**

- Add the migrations from Section 13.1 steps 1, 5, and 6.
- Add `src/lib/rewards/settlement-root.ts` and its unit tests.
- Add `src/lib/rewards/settlement-root.db.test.ts`.
- Add/update generated `src/types/database.ts` only from the local schema
  generator.

**RED assertions:**

- Root terms and statuses match the exact constraints.
- Existing Poll reward campaign IDs backfill one-to-one into roots.
- `poll_id` remains required and unique.
- A root cannot have two source bindings or a mismatched adapter owner.
- A Campaign source cannot bind to a Poll adapter.
- Public/authenticated roles cannot read root, binding, or financial rows.

**GREEN work:** create the root, binding, backfill, guarded resolver, and local
schema assertions without changing Poll route behavior.

**Commands:**

```text
npm test -- src/lib/rewards/settlement-root.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/rewards/settlement-root.db.test.ts
npx tsc --noEmit
npm run lint
```

### 16.2 V2C.2B - Campaign product/configuration entity

**Planned commit:** `feat(v2c2): add Campaign configuration boundary`

**Files:**

- Add `src/lib/campaigns/types.ts`.
- Add `src/lib/campaigns/configuration.ts`.
- Add `src/lib/campaigns/configuration.test.ts`.
- Add `src/lib/campaigns/configuration.db.test.ts`.
- Add configuration route tests only if configuration routes are implemented.
- Add the migration from Section 13.1 step 2.

**RED assertions:**

- Owner comes only from the verified session.
- Exactly five type literals are accepted.
- Type, owner, and settlement binding become immutable at publication.
- Window, visibility, title, and description constraints are enforced.
- Drafts may be edited; published configuration cannot be edited in place.
- No configuration operation accepts client economics, vault, claim state, or
  receipt data.
- No Poll row is created or modified.

**GREEN work:** implement draft creation, draft updates, publication validation,
and safe configuration responses. Do not add claim or discovery routes.

**Commands:**

```text
npm test -- src/lib/campaigns/configuration.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/campaigns/configuration.db.test.ts
npx tsc --noEmit
npm run lint
```

### 16.3 V2C.2C - Versioned eligibility configuration storage

**Planned commit:** `feat(v2c2): add Campaign eligibility configuration storage`

**Files:**

- Add the migration from Section 13.1 step 3.
- Add `src/lib/campaigns/eligibility-config.ts`.
- Add `src/lib/campaigns/eligibility-config.test.ts`.
- Add `src/lib/campaigns/eligibility-config.db.test.ts`.

**RED assertions:**

- Secret rows contain only a strong digest and never plaintext.
- Allowlist writes canonicalize addresses and reject duplicate version entries.
- Activated allowlist versions cannot be mutated.
- Event proofs are hashed and scoped to Campaign/version/expiry.
- Community membership remains separate from `funding_mode = community`.
- No strategy configuration creates a receipt, payout, funding intent, or NIM
  transfer.

**GREEN work:** add service-role configuration/import functions and immutable
version selection. Do not evaluate a claim or expose strategy rows publicly.

**Commands:**

```text
npm test -- src/lib/campaigns/eligibility-config.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/campaigns/eligibility-config.db.test.ts
npx tsc --noEmit
npm run lint
```

### 16.4 V2C.2D - Claim identity schema and challenge binding

**Planned commit:** `feat(v2c2): add Campaign claim identity protections`

**Files:**

- Add the migration from Section 13.1 step 4.
- Add `src/lib/campaigns/claim-identity.ts`.
- Add `src/lib/campaigns/claim-identity.test.ts`.
- Add `src/lib/campaigns/claim-identity.db.test.ts`.
- Modify wallet challenge verification only when the new Campaign purpose is
  implemented; preserve the generic wallet-session purpose and behavior.

**RED assertions:**

- Campaign challenge messages bind purpose, Campaign ID, wallet, nonce, and
  expiry.
- Nonces are stored hashed and consumed once.
- One canonical wallet has one Campaign claim row.
- Cross-Campaign and cross-wallet replay fails closed.
- Existing generic wallet proof challenges still pass unchanged.
- Claim rows contain no plaintext secret, QR payload, amount, vault, or option.

**GREEN work:** add durable schema and server-only claim identity helpers. Do
not add a Claim endpoint or invoke reservation from this slice.

**Commands:**

```text
npm test -- src/lib/campaigns/claim-identity.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/campaigns/claim-identity.db.test.ts
npx tsc --noEmit
npm run lint
```

### 16.5 V2C.2E - Financial root cutover and Poll compatibility

**Planned commit:** `feat(v2c2): root shared financial engine on settlements`

**Files:**

- Add the migrations from Section 13.1 steps 7 and 8.
- Modify `src/lib/rewards/settlement.ts` and add/update
  `src/lib/rewards/settlement-root.ts`.
- Modify `src/lib/rewards/reservation-service.ts` and Poll adapter stores.
- Modify `src/lib/rewards/closure.ts` and Poll closure adapter stores.
- Modify funding, payout, payout-reconciliation, refund, and
  refund-reconciliation loaders only to change root lookup.
- Update corresponding route tests without changing public Poll paths.

**RED assertions:**

- A Poll URL resolves the root through its Poll adapter and binding, never by
  treating a Poll ID as a root ID.
- Existing funding, receipt, payout, refund, and vault IDs remain reachable.
- An unrelated child row cannot be reached through another root.
- Root accounting increments paid principal and confirmed fee together.
- No root transition accepts Poll options or Campaign strategy data.
- Poll vote response remains `201` on successful vote even if reward follow-up
  fails.
- Rewarded reward-first Polls still pay automatically; free and legacy Polls do
  not create reward work.
- Hash reuse, payout unknown-outcome, retry, finality, and refund freeze rules
  remain green.

**GREEN work:** update root loaders/RPCs and compatibility adapters while
preserving physical compatibility aliases and the existing irreversible
boundaries.

**Commands:**

```text
npm test -- src/lib/rewards/settlement.test.ts src/lib/rewards/reservation-service.test.ts src/lib/rewards/closure.test.ts src/lib/rewards/v2c1-compatibility.test.ts
npm test -- --pool=forks --maxWorkers=1 --no-file-parallelism src/lib/rewards/settlement-root.db.test.ts src/lib/rewards/reservation.db.test.ts src/lib/rewards/funding-confirmation.db.test.ts src/lib/rewards/payout.db.test.ts src/lib/rewards/refund-preparation.db.test.ts src/lib/rewards/refund-reconciliation.db.test.ts
npx tsc --noEmit
npm run lint
```

### 16.6 V2C.2F - Full Campaign foundation gate

**Planned commit:** `test(v2c2): verify Campaign foundation boundaries`

**Files:**

- Add `src/lib/campaigns/v2c2-foundation.test.ts`.
- Add/update only the focused DB and route tests needed to close a demonstrated
  assertion gap.

**RED/static assertions:**

- Search production code and migrations for accidental Campaign claims, UI,
  NIM sends, secret plaintext, selected-option leakage, or second ledgers.
- Confirm all private tables are inaccessible to public roles.
- Confirm all five types have configuration storage but no enabled claim flow.
- Confirm no `reward_campaigns.poll_id` nullability or Poll creation behavior
  changed.
- Confirm NIM funding, payout, finality, and refund proof remain the financial
  center of the design.

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

Database commands are local-only and must use the existing
`assertLocalSupabaseForTests()` guard. If local Supabase is unavailable, the
exact DB command and reason are recorded as skipped; a hosted database is never
used as a substitute.

## 17. Regression and Acceptance Tests

### 17.1 Required regression baseline

The V2C.1 baseline is:

- full Vitest: 57 files and 621 tests passed;
- focused V2C.1 financial/adapter/closure suites: 11 files and 162 tests
  passed;
- schema gate: 59 passed;
- configuration gate: 75 passed;
- funding gate: 57 passed;
- persisted vault gate: 16 passed;
- V2B.1 backward compatibility: 59 passed;
- lint, typecheck, and production build passed.

V2C.2 must rerun the current baseline after root cutover. It may not replace
the baseline with Campaign-only tests.

### 17.2 Database acceptance

- All seven new tables/relationships and their indexes/constraints exist.
- Root and adapter owners match canonically.
- Every existing Poll reward campaign has exactly one root and binding.
- Every standalone Campaign has exactly one root and binding.
- No root has two source adapters.
- Canonical wallet uniqueness is database-enforced for claims and allowlists.
- Claim nonce and challenge consumption are single-use and atomic.
- Activated strategy configuration is immutable.
- No secret, event proof, challenge nonce, or vault ciphertext is publicly
  readable.
- Root financial child foreign keys reject cross-settlement access.
- Existing transaction hash uniqueness remains cross-ledger safe.
- Root accounting rejects underpayment, overspend, fee mismatch, and invalid
  refund values.

### 17.3 Poll compatibility acceptance

- Poll publication, discovery, voting, receipts, and public reward reads retain
  their existing response shapes.
- Legacy support Polls remain support Polls.
- Free reward-first Polls create no reward campaign/receipt/funding/payout/refund
  obligation.
- Rewarded reward-first Polls retain automatic reservation and payout.
- Creator votes remain valid Poll votes but do not produce reward receipts.
- Exhausted capacity does not invalidate an already committed vote.
- Poll options never enter shared context, settlement root, receipts, payout,
  refund, profile metrics, or public reward proof.
- Reservation/payout failure remains best-effort after vote commit.

### 17.4 Security acceptance

- No browser request can author economics, wallet identity, source binding,
  eligibility, claim state, refund amount, or finality evidence.
- Secret errors do not enumerate Campaigns or codes.
- Allowlist and community membership are private and versioned.
- Event proofs are scoped, expiring, hash-only, and replay-safe.
- Hash-bearing payout/refund uncertainty never triggers a blind resend.
- Confirmed payout/refund proof is immutable and requires macro finality.
- The vault private key remains server-only and transient during signing.

## 18. Release Gates and Non-Goals

### 18.1 V2C.2 completion means

- The Campaign product entity and configuration model are specified and, in a
  later implementation, can be created/validated without touching Polls.
- The generic settlement root and explicit Poll binding are specified with a
  deterministic preservation/backfill strategy.
- Strategy storage is private, versioned, hash-only where sensitive, and not a
  second financial ledger.
- Claim identity schema and replay boundaries are specified but not enabled as a
  claim flow.
- Poll financial behavior remains protected by the existing regression gate.

### 18.2 V2C.2 does not mean

- No standalone Campaign claim endpoint or Claim button.
- No Public Giveaway payout vertical slice.
- No Secret Drop code redemption.
- No Private Drop allowlist claim evaluation.
- No Event Drop QR/deep-link physical validation.
- No Community Reward external membership integration.
- No Campaign discovery, ranking, or public proof surface.
- No Campaign UI or navigation changes.
- No new NIM transfer, wallet approval, or physical Nimiq Pay QA.
- No production deployment, hosted Supabase mutation, Docker startup, or main
  branch merge.
- No betting, prediction market, gambling, winner-takes-pot, or pooled prize
  semantics.

### 18.3 Release dependency

V2C.2 configuration is not a funded Campaign release. Before any real Campaign
can hold funds or undergo physical QA, the project must complete the generic
Public Giveaway claim path, creator management, unresolved/manual-review
handling, closure/refund finality, public proof limits, security review, and
device validation. The first release type remains Public Giveaway; the other
four remain configuration-only until their strategy and threat-model gates pass.

## 19. NIM-Centered Proof and Type Readiness

Every Campaign type remains NIM-centered. Eligibility is an off-chain unlock
condition, not the value proposition by itself. The shared financial proof is:

```text
creator/designated funder commits NIM
  -> isolated settlement vault receives observed funding
  -> capacity is bounded by funded principal
  -> one canonical wallet reservation creates one receipt
  -> vault signs the exact integer-Luna payout
  -> stored hash is observed on Nimiq
  -> exact transfer is canonical and macro-final
  -> receipt becomes paid
  -> unresolved obligations settle before conservative refund
```

| Type | Off-chain eligibility | NIM proof that remains central | V2C.2 readiness |
|---|---|---|---|
| Public Giveaway | Verified wallet and capacity | Funded isolated vault, exact payout, observed canonical/macro-final transfer, receipt proof | Configuration-ready only; first future vertical slice |
| Secret Drop | Server-verified secret | Same funding, payout, finality, and refund proof; secret entry itself is not chain proof | Not claim-ready |
| Private Drop | Immutable private allowlist membership | Same NIM settlement and exact final payout proof; allowlist membership is not chain proof | Not claim-ready |
| Event Drop | Scoped event code, opaque link, or QR proof | Same NIM settlement and finality proof; QR/deep link is only activation transport | Not physical-QA-ready |
| Community Reward | Versioned internal contributor/community membership | Same NIM settlement and payout proof; membership is not implied by funding mode | Not claim-ready |

NIM remains product-critical because the creator/funder prepays real NIM, the
root accounts a bounded principal and fee reserve, the isolated vault performs
the actual reward transfer, and `paid`/`refunded` require observed chain proof.
Removing that path would produce a generic code/allowlist application rather
than Votum.

### Final design verdict

V2C.2 should add `participation_campaigns` as a product entity and
`reward_settlements` as the one generic financial root. Existing Polls remain
Polls through `reward_campaigns` and an explicit source binding. Campaign types
store configuration only; no claim or NIM execution is enabled by this design.
The next implementation task, if approved, is the root/backfill migration and
its Poll compatibility gate, not a Campaign claim flow.
