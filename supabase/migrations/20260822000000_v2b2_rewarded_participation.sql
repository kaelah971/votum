-- V2B.2 rewarded participation foundation (additive only).
-- New reward tables only. No existing table/column/row is altered.
-- No plaintext vault keys, no option_id / selected-option fields anywhere.
-- One campaign per poll (UNIQUE poll_id); one reward per wallet per campaign.
-- All money is integer Luna (bigint). Status uses text + CHECK (repo convention).

-- ============================================================================
-- REWARD CAMPAIGNS
-- ============================================================================

CREATE TABLE public.reward_campaigns (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    poll_id                   uuid NOT NULL UNIQUE REFERENCES public.polls(id),
    creator_wallet            text NOT NULL,
    reward_per_participant_luna bigint NOT NULL,
    max_rewarded_participants integer NOT NULL,
    reward_principal_luna     bigint NOT NULL,
    fee_reserve_luna          bigint NOT NULL DEFAULT 0,
    total_budget_luna         bigint NOT NULL,
    asset                     text NOT NULL DEFAULT 'NIM',
    status                    text NOT NULL DEFAULT 'configured',
    funded_amount_luna        bigint NOT NULL DEFAULT 0,
    refundable_excess_luna    bigint NOT NULL DEFAULT 0,
    rewarded_participant_count integer NOT NULL DEFAULT 0,
    paid_amount_luna          bigint NOT NULL DEFAULT 0,
    fee_spent_luna            bigint NOT NULL DEFAULT 0,
    refundable_amount_luna    bigint NOT NULL DEFAULT 0,
    first_reservation_at      timestamptz,
    vault_wallet              text,
    vault_key_ref             text,
    created_at                timestamptz NOT NULL DEFAULT now(),
    funded_at                 timestamptz,
    closed_at                 timestamptz,
    refunded_at               timestamptz,
    updated_at                timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reward_campaigns_creator_wallet_not_empty CHECK (length(trim(creator_wallet)) > 0),
    CONSTRAINT reward_campaigns_min_reward CHECK (reward_per_participant_luna >= 1000),
    CONSTRAINT reward_campaigns_max_participants CHECK (max_rewarded_participants > 0),
    CONSTRAINT reward_campaigns_asset CHECK (asset = 'NIM'),
    CONSTRAINT reward_campaigns_principal_math CHECK (
        reward_principal_luna = reward_per_participant_luna * max_rewarded_participants
    ),
    CONSTRAINT reward_campaigns_fee_reserve_nonneg CHECK (fee_reserve_luna >= 0),
    CONSTRAINT reward_campaigns_total_math CHECK (
        total_budget_luna = reward_principal_luna + fee_reserve_luna
    ),
    CONSTRAINT reward_campaigns_status CHECK (
        status IN ('configured', 'funding_pending', 'funded', 'rewarding',
                   'exhausted', 'closed', 'refunding', 'refunded', 'cancelled')
    ),
    CONSTRAINT reward_campaigns_funded_nonneg CHECK (funded_amount_luna >= 0),
    CONSTRAINT reward_campaigns_excess_nonneg CHECK (refundable_excess_luna >= 0),
    CONSTRAINT reward_campaigns_count_range CHECK (
        rewarded_participant_count >= 0
        AND rewarded_participant_count <= max_rewarded_participants
    ),
    CONSTRAINT reward_campaigns_paid_nonneg CHECK (paid_amount_luna >= 0),
    CONSTRAINT reward_campaigns_fee_spent_nonneg CHECK (fee_spent_luna >= 0),
    CONSTRAINT reward_campaigns_refundable_nonneg CHECK (refundable_amount_luna >= 0),
    CONSTRAINT reward_campaigns_no_overspend CHECK (
        paid_amount_luna + fee_spent_luna <= funded_amount_luna
    )
);

CREATE INDEX idx_reward_campaigns_creator ON public.reward_campaigns (creator_wallet);
CREATE INDEX idx_reward_campaigns_status ON public.reward_campaigns (status);

-- ============================================================================
-- REWARD FUNDING TRANSACTIONS (creator prepaid budget; bind→observe→confirm)
-- ============================================================================

CREATE TABLE public.reward_funding_transactions (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id               uuid NOT NULL REFERENCES public.reward_campaigns(id),
    creator_wallet            text NOT NULL,
    reference                 text UNIQUE NOT NULL,
    submitted_transaction_hash text,
    confirmed_transaction_hash text,
    amount_luna               bigint NOT NULL,
    status                    text NOT NULL DEFAULT 'submitted',
    confirmation_deadline     timestamptz,
    block_number              bigint,
    transaction_timestamp     timestamptz,
    confirmed_at              timestamptz,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reward_funding_creator_wallet_not_empty CHECK (length(trim(creator_wallet)) > 0),
    CONSTRAINT reward_funding_amount_positive CHECK (amount_luna > 0),
    CONSTRAINT reward_funding_status CHECK (
        status IN ('submitted', 'confirmed', 'rejected')
    )
);

-- One hash reserved by at most one funding row (idempotency).
CREATE UNIQUE INDEX idx_reward_funding_submitted_hash
    ON public.reward_funding_transactions (submitted_transaction_hash)
    WHERE submitted_transaction_hash IS NOT NULL;

CREATE UNIQUE INDEX idx_reward_funding_confirmed_hash
    ON public.reward_funding_transactions (confirmed_transaction_hash)
    WHERE confirmed_transaction_hash IS NOT NULL;

CREATE INDEX idx_reward_funding_campaign ON public.reward_funding_transactions (campaign_id);
CREATE INDEX idx_reward_funding_creator ON public.reward_funding_transactions (creator_wallet);

-- ============================================================================
-- REWARD RECEIPTS (per-wallet participation-reward ledger)
-- ============================================================================
-- NO option_id / option text / vote payload anywhere. Proves only
-- "wallet X participated in poll Y and is entitled to Z NIM".

CREATE TABLE public.reward_receipts (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id               uuid NOT NULL REFERENCES public.reward_campaigns(id),
    poll_id                   uuid NOT NULL REFERENCES public.polls(id),
    participant_wallet        text NOT NULL,
    amount_luna               bigint NOT NULL,
    status                    text NOT NULL DEFAULT 'eligible',
    paid_at                   timestamptz,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reward_receipts_wallet_not_empty CHECK (length(trim(participant_wallet)) > 0),
    CONSTRAINT reward_receipts_amount_positive CHECK (amount_luna > 0),
    CONSTRAINT reward_receipts_status CHECK (
        status IN ('eligible', 'reserved', 'payout_pending', 'paid', 'failed', 'retryable')
    ),
    CONSTRAINT reward_receipts_one_per_wallet UNIQUE (campaign_id, participant_wallet)
);

CREATE INDEX idx_reward_receipts_campaign ON public.reward_receipts (campaign_id);
CREATE INDEX idx_reward_receipts_participant ON public.reward_receipts (participant_wallet);
CREATE INDEX idx_reward_receipts_poll ON public.reward_receipts (poll_id);

-- ============================================================================
-- REWARD PAYOUT ATTEMPTS (execution/retry log; signing/broadcast added later)
-- ============================================================================

CREATE TABLE public.reward_payout_attempts (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id                uuid NOT NULL REFERENCES public.reward_receipts(id),
    attempt_number            integer NOT NULL,
    status                    text NOT NULL DEFAULT 'pending',
    transaction_hash          text,
    error_code                text,
    broadcast_at              timestamptz,
    confirmed_at              timestamptz,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reward_payout_attempt_number_positive CHECK (attempt_number > 0),
    CONSTRAINT reward_payout_attempt_status CHECK (
        status IN ('pending', 'confirmed', 'failed', 'retryable')
    ),
    CONSTRAINT reward_payout_attempt_unique UNIQUE (receipt_id, attempt_number)
);

-- One payout hash used once across the whole payout ledger.
CREATE UNIQUE INDEX idx_reward_payout_hash
    ON public.reward_payout_attempts (transaction_hash)
    WHERE transaction_hash IS NOT NULL;

CREATE INDEX idx_reward_payout_receipt ON public.reward_payout_attempts (receipt_id);

-- ============================================================================
-- REWARD REFUNDS (explicit creator refunds)
-- ============================================================================
-- Refund destination MUST derive from immutable campaign creator identity;
-- no mutable arbitrary recipient is modelled here.

CREATE TABLE public.reward_refunds (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id               uuid NOT NULL REFERENCES public.reward_campaigns(id),
    creator_wallet            text NOT NULL,
    amount_luna               bigint NOT NULL,
    status                    text NOT NULL DEFAULT 'pending',
    transaction_hash          text,
    block_number              bigint,
    transaction_timestamp     timestamptz,
    confirmed_at              timestamptz,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reward_refunds_creator_wallet_not_empty CHECK (length(trim(creator_wallet)) > 0),
    CONSTRAINT reward_refunds_amount_positive CHECK (amount_luna > 0),
    CONSTRAINT reward_refunds_status CHECK (
        status IN ('pending', 'confirmed', 'failed', 'retryable')
    )
);

-- One active refund per campaign (pending/confirmed).
CREATE UNIQUE INDEX idx_reward_refunds_active
    ON public.reward_refunds (campaign_id)
    WHERE status IN ('pending', 'confirmed');

CREATE UNIQUE INDEX idx_reward_refunds_hash
    ON public.reward_refunds (transaction_hash)
    WHERE transaction_hash IS NOT NULL;

CREATE INDEX idx_reward_refunds_campaign ON public.reward_refunds (campaign_id);

-- ============================================================================
-- RLS — internal financial tables; anon/authenticated fully revoked.
-- ============================================================================

ALTER TABLE public.reward_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_funding_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_payout_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_refunds ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.reward_campaigns FROM anon, authenticated;
REVOKE ALL ON public.reward_funding_transactions FROM anon, authenticated;
REVOKE ALL ON public.reward_receipts FROM anon, authenticated;
REVOKE ALL ON public.reward_payout_attempts FROM anon, authenticated;
REVOKE ALL ON public.reward_refunds FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.reward_campaigns TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.reward_funding_transactions TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.reward_receipts TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.reward_payout_attempts TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.reward_refunds TO service_role;

-- ============================================================================
-- PUBLIC READ SURFACE (D7 allowlist) — funded state + offer only.
-- Never exposes vault key material, ciphertext, auth/session data, or any
-- chosen-option data.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_public_reward_campaign(_poll_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
    _campaign public.reward_campaigns%ROWTYPE;
    _remaining integer;
BEGIN
    SELECT * INTO _campaign
    FROM public.reward_campaigns
    WHERE poll_id = _poll_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'not_found');
    END IF;

    _remaining := _campaign.max_rewarded_participants - _campaign.rewarded_participant_count;
    IF _remaining < 0 THEN
        _remaining := 0;
    END IF;

    RETURN jsonb_build_object(
        'result_kind', 'found',
        'pollId', _campaign.poll_id,
        'campaignId', _campaign.id,
        'status', _campaign.status,
        'funded', _campaign.status IN ('funded', 'rewarding'),
        'rewardPerParticipantLuna', _campaign.reward_per_participant_luna::text,
        'maxRewardedParticipants', _campaign.max_rewarded_participants,
        'rewardPrincipalLuna', _campaign.reward_principal_luna::text,
        'rewardsRemaining', _remaining
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_reward_campaign TO anon, authenticated, service_role;
