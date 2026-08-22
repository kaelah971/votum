-- V2B.2.4 campaign funding initiation only.
--
-- This migration creates the INTENT -> BIND boundary. It deliberately does
-- not observe a transaction, update confirmed funding, or advance a campaign
-- to funded. V2B.2.5 owns chain observation and confirmation.

-- Snapshot the terms and recipient used by an intent. These values are copied
-- from the locked campaign/vault inside the atomic begin function; clients
-- never provide them.
ALTER TABLE public.reward_funding_transactions
  ADD COLUMN vault_wallet text;

ALTER TABLE public.reward_funding_transactions
  ADD COLUMN reward_principal_luna bigint;

ALTER TABLE public.reward_funding_transactions
  ADD COLUMN fee_reserve_luna bigint;

ALTER TABLE public.reward_funding_transactions
  ADD COLUMN submitted_at timestamptz;

-- One active attempt per campaign. Rejected attempts may be retried later.
CREATE UNIQUE INDEX idx_reward_funding_active_campaign
  ON public.reward_funding_transactions (campaign_id)
  WHERE status = 'submitted';

-- ============================================================================
-- BEGIN FUNDING INTENT
-- ============================================================================

CREATE OR REPLACE FUNCTION public.begin_reward_funding_atomic(
    _campaign_id uuid,
    _creator_wallet text,
    _confirmation_horizon_minutes integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign record;
    _poll_public boolean;
    _vault record;
    _active record;
    _intent record;
    _horizon integer;
BEGIN
    _horizon := GREATEST(5, LEAST(COALESCE(_confirmation_horizon_minutes, 60), 1440));

    -- The campaign row is the concurrency boundary. Every begin request for
    -- one campaign serializes before it can inspect or create an intent.
    SELECT c.* INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;

    IF lower(_campaign.creator_wallet) <> lower(_creator_wallet) THEN
        RETURN jsonb_build_object('result_kind', 'forbidden');
    END IF;

    SELECT p.is_public INTO _poll_public
    FROM public.polls p
    WHERE p.id = _campaign.poll_id;

    IF NOT COALESCE(_poll_public, false) THEN
        RETURN jsonb_build_object('result_kind', 'poll_not_public');
    END IF;

    SELECT v.vault_address_hex INTO _vault
    FROM public.reward_campaign_vaults v
    WHERE v.campaign_id = _campaign_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'vault_missing');
    END IF;

    IF _campaign.total_budget_luna > 9007199254740991::bigint THEN
        RETURN jsonb_build_object('result_kind', 'funding_amount_unsafe');
    END IF;

    -- A submitted row is the reusable active intent. This makes retries and
    -- concurrent clicks return one authoritative economic record.
    SELECT f.* INTO _active
    FROM public.reward_funding_transactions f
    WHERE f.campaign_id = _campaign_id
      AND f.status = 'submitted'
    ORDER BY f.created_at DESC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'result_kind', 'replay',
            'intent_id', _active.id,
            'campaign_id', _active.campaign_id,
            'reference', _active.reference,
            'vault_wallet', _active.vault_wallet,
            'reward_principal_luna', _active.reward_principal_luna::text,
            'fee_reserve_luna', _active.fee_reserve_luna::text,
            'amount_luna', _active.amount_luna::text,
            'submitted_transaction_hash', _active.submitted_transaction_hash,
            'confirmation_deadline', _active.confirmation_deadline,
            'created_at', _active.created_at
        );
    END IF;

    IF _campaign.status <> 'configured' THEN
        RETURN jsonb_build_object(
            'result_kind', 'campaign_state_conflict',
            'state', _campaign.status
        );
    END IF;

    INSERT INTO public.reward_funding_transactions (
        campaign_id,
        creator_wallet,
        reference,
        amount_luna,
        status,
        confirmation_deadline,
        vault_wallet,
        reward_principal_luna,
        fee_reserve_luna
    ) VALUES (
        _campaign_id,
        _campaign.creator_wallet,
        'votum:fund:' || replace(gen_random_uuid()::text, '-', ''),
        _campaign.total_budget_luna,
        'submitted',
        now() + (_horizon || ' minutes')::interval,
        _vault.vault_address_hex,
        _campaign.reward_principal_luna,
        _campaign.fee_reserve_luna
    )
    RETURNING * INTO _intent;

    UPDATE public.reward_campaigns
    SET status = 'funding_pending', updated_at = now()
    WHERE id = _campaign_id;

    RETURN jsonb_build_object(
        'result_kind', 'created',
        'intent_id', _intent.id,
        'campaign_id', _intent.campaign_id,
        'reference', _intent.reference,
        'vault_wallet', _intent.vault_wallet,
        'reward_principal_luna', _intent.reward_principal_luna::text,
        'fee_reserve_luna', _intent.fee_reserve_luna::text,
        'amount_luna', _intent.amount_luna::text,
        'submitted_transaction_hash', _intent.submitted_transaction_hash,
        'confirmation_deadline', _intent.confirmation_deadline,
        'created_at', _intent.created_at
    );
END;
$$;

-- ============================================================================
-- BIND BROADCAST HASH
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bind_reward_funding_transaction_atomic(
    _campaign_id uuid,
    _intent_id uuid,
    _creator_wallet text,
    _transaction_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign record;
    _intent record;
    _existing record;
    _hash_lock bigint;
BEGIN
    SELECT c.* INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;

    IF lower(_campaign.creator_wallet) <> lower(_creator_wallet) THEN
        RETURN jsonb_build_object('result_kind', 'forbidden');
    END IF;

    IF _campaign.status <> 'funding_pending' THEN
        RETURN jsonb_build_object(
            'result_kind', 'campaign_state_conflict',
            'state', _campaign.status
        );
    END IF;

    IF _transaction_hash IS NULL OR _transaction_hash !~ '^[0-9a-f]{64}$' THEN
        RETURN jsonb_build_object('result_kind', 'invalid_hash');
    END IF;

    -- Serialize reuse checks for the same hash across funding, support,
    -- payout, and refund ledgers. Funding never owns a hash already used by
    -- another financial record.
    _hash_lock := ('x' || substr(_transaction_hash, 1, 15))::bit(64)::bigint;
    IF _hash_lock = 0 THEN _hash_lock := 1; END IF;
    PERFORM pg_advisory_xact_lock(_hash_lock);

    SELECT f.* INTO _intent
    FROM public.reward_funding_transactions f
    WHERE f.id = _intent_id
      AND f.campaign_id = _campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'intent_not_found');
    END IF;

    IF _intent.submitted_transaction_hash = _transaction_hash THEN
        RETURN jsonb_build_object(
            'result_kind', 'bound_replay',
            'intent_id', _intent.id,
            'campaign_id', _intent.campaign_id,
            'reference', _intent.reference,
            'submitted_transaction_hash', _intent.submitted_transaction_hash
        );
    END IF;

    IF _intent.submitted_transaction_hash IS NOT NULL THEN
        RETURN jsonb_build_object('result_kind', 'intent_already_bound');
    END IF;

    IF _intent.status <> 'submitted' THEN
        RETURN jsonb_build_object('result_kind', 'intent_state_conflict', 'state', _intent.status);
    END IF;

    SELECT f.id INTO _existing
    FROM public.reward_funding_transactions f
    WHERE f.id <> _intent_id
      AND (
        f.submitted_transaction_hash = _transaction_hash
        OR f.confirmed_transaction_hash = _transaction_hash
      )
    LIMIT 1;

    IF FOUND THEN
        RETURN jsonb_build_object('result_kind', 'transaction_already_reserved');
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.nim_support_intents s
        WHERE s.submitted_transaction_hash = _transaction_hash
    ) OR EXISTS (
        SELECT 1 FROM public.nim_contributions c
        WHERE c.transaction_hash = _transaction_hash
    ) OR EXISTS (
        SELECT 1 FROM public.reward_payout_attempts p
        WHERE p.transaction_hash = _transaction_hash
    ) OR EXISTS (
        SELECT 1 FROM public.reward_refunds r
        WHERE r.transaction_hash = _transaction_hash
    ) THEN
        RETURN jsonb_build_object('result_kind', 'transaction_already_reserved');
    END IF;

    UPDATE public.reward_funding_transactions
    SET submitted_transaction_hash = _transaction_hash,
        submitted_at = now(),
        updated_at = now()
    WHERE id = _intent_id;

    RETURN jsonb_build_object(
        'result_kind', 'bound',
        'intent_id', _intent_id,
        'campaign_id', _campaign_id,
        'reference', _intent.reference,
        'submitted_transaction_hash', _transaction_hash
    );
EXCEPTION
    WHEN unique_violation THEN
        -- Covers the cross-campaign race on the partial hash index. The
        -- transaction rolls back and the caller receives a safe conflict.
        RETURN jsonb_build_object('result_kind', 'transaction_already_reserved');
END;
$$;

GRANT EXECUTE ON FUNCTION public.begin_reward_funding_atomic TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_reward_funding_transaction_atomic TO service_role;
REVOKE EXECUTE ON FUNCTION public.begin_reward_funding_atomic FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bind_reward_funding_transaction_atomic FROM PUBLIC, anon, authenticated;
