-- V2C.2A generic settlement root (snapshot only).
--
-- reward_campaigns remains the live financial authority until the later V2C.2E
-- cutover. This migration creates only the source-neutral mirror table; it does
-- not alter any existing Poll or financial row.

CREATE TABLE public.reward_settlements (
    id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_wallet                 text NOT NULL,
    funding_wallet               text NOT NULL,
    refund_recipient_wallet      text NOT NULL,
    funding_mode                 text NOT NULL DEFAULT 'creator',
    asset                        text NOT NULL DEFAULT 'NIM',
    reward_per_participant_luna  bigint NOT NULL,
    max_rewarded_participants    integer NOT NULL,
    reward_principal_luna        bigint NOT NULL,
    fee_reserve_luna             bigint NOT NULL DEFAULT 0,
    total_budget_luna            bigint NOT NULL,
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
    payout_lock_token             text,
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

ALTER TABLE public.reward_settlements ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.reward_settlements FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.reward_settlements TO service_role;
