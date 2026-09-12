-- V2B.2.11 Phase C - sign and broadcast one prepared creator refund.
--
-- This migration stops at the broadcast callback. It never observes chain
-- finality and never changes a refund or campaign to a confirmed/final state.

-- Persist the signed transaction and the crash-window markers separately from
-- transaction_hash. The latter is the normalized node callback hash; the
-- prepared hash is durable before the external broadcast call.
ALTER TABLE public.reward_refunds
  ADD COLUMN sender_address_hex text,
  ADD COLUMN recipient_address_hex text,
  ADD COLUMN fee_luna bigint,
  ADD COLUMN network_id integer,
  ADD COLUMN validity_start_height integer,
  ADD COLUMN prepared_transaction_hex text,
  ADD COLUMN prepared_transaction_hash text,
  ADD COLUMN prepared_at timestamptz,
  ADD COLUMN broadcast_started_at timestamptz,
  ADD COLUMN broadcast_at timestamptz,
  ADD COLUMN error_code text;

ALTER TABLE public.reward_refunds
  ADD CONSTRAINT reward_refund_transaction_hash_format
    CHECK (transaction_hash IS NULL OR transaction_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT reward_refund_prepared_hash_format
    CHECK (prepared_transaction_hash IS NULL OR prepared_transaction_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT reward_refund_prepared_sender_not_empty
    CHECK (sender_address_hex IS NULL OR length(trim(sender_address_hex)) > 0),
  ADD CONSTRAINT reward_refund_prepared_recipient_not_empty
    CHECK (recipient_address_hex IS NULL OR length(trim(recipient_address_hex)) > 0),
  ADD CONSTRAINT reward_refund_prepared_fee_nonneg
    CHECK (fee_luna IS NULL OR fee_luna >= 0),
  ADD CONSTRAINT reward_refund_prepared_network_nonneg
    CHECK (network_id IS NULL OR network_id >= 0),
  ADD CONSTRAINT reward_refund_prepared_height_nonneg
    CHECK (validity_start_height IS NULL OR validity_start_height >= 0),
  ADD CONSTRAINT reward_refund_prepared_hex_format
    CHECK (
      prepared_transaction_hex IS NULL
      OR (
        length(prepared_transaction_hex) > 0
        AND prepared_transaction_hex ~ '^[0-9a-f]+$'
        AND length(prepared_transaction_hex) % 2 = 0
      )
    ),
  ADD CONSTRAINT reward_refund_prepared_fields_complete
    CHECK (
      (
        prepared_transaction_hash IS NULL
        AND prepared_transaction_hex IS NULL
        AND sender_address_hex IS NULL
        AND recipient_address_hex IS NULL
        AND fee_luna IS NULL
        AND network_id IS NULL
        AND validity_start_height IS NULL
        AND prepared_at IS NULL
      )
      OR (
        prepared_transaction_hash IS NOT NULL
        AND prepared_transaction_hex IS NOT NULL
        AND sender_address_hex IS NOT NULL
        AND recipient_address_hex IS NOT NULL
        AND fee_luna IS NOT NULL
        AND network_id IS NOT NULL
        AND validity_start_height IS NOT NULL
        AND prepared_at IS NOT NULL
      )
    ),
  ADD CONSTRAINT reward_refund_broadcast_markers_consistent
    CHECK (
      (broadcast_started_at IS NULL OR prepared_transaction_hash IS NOT NULL)
      AND (broadcast_at IS NULL OR broadcast_started_at IS NOT NULL)
      AND (transaction_hash IS NULL OR broadcast_at IS NOT NULL)
      AND (broadcast_at IS NULL OR transaction_hash IS NOT NULL)
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_campaign_vaults_address
  ON public.reward_campaign_vaults (vault_address_hex);

-- ==========================================================================
-- Shared campaign-vault lease for refund execution
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.acquire_reward_refund_vault_lock_atomic(
    _campaign_id uuid,
    _refund_id uuid,
    _lock_token text,
    _lease_seconds integer DEFAULT 120
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign record;
    _refund_campaign uuid;
    _lease integer := GREATEST(30, LEAST(COALESCE(_lease_seconds, 120), 600));
BEGIN
    -- This is the same lease row and lock order used by payout execution.
    SELECT c.payout_lock_attempt_id, c.payout_lock_token,
           c.payout_lock_expires_at, c.status
    INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;

    SELECT r.campaign_id INTO _refund_campaign
    FROM public.reward_refunds r
    WHERE r.id = _refund_id
    FOR SHARE;

    IF NOT FOUND OR _refund_campaign <> _campaign_id THEN
        RETURN jsonb_build_object('result_kind', 'refund_campaign_mismatch');
    END IF;
    IF _campaign.status <> 'refunding' THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_refunding');
    END IF;
    IF _lock_token IS NULL OR length(trim(_lock_token)) = 0 THEN
        RETURN jsonb_build_object('result_kind', 'lock_token_invalid');
    END IF;

    IF _campaign.payout_lock_token IS NOT NULL
       AND _campaign.payout_lock_token <> _lock_token
       AND _campaign.payout_lock_expires_at > now() THEN
        RETURN jsonb_build_object('result_kind', 'busy');
    END IF;

    UPDATE public.reward_campaigns
    SET payout_lock_attempt_id = _refund_id,
        payout_lock_token = _lock_token,
        payout_lock_expires_at = now() + (_lease || ' seconds')::interval,
        updated_at = now()
    WHERE id = _campaign_id;

    RETURN jsonb_build_object('result_kind', 'acquired');
END;
$$;

-- ==========================================================================
-- Persist a signed refund before the external broadcast call
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.prepare_reward_refund_transaction_atomic(
    _refund_id                  uuid,
    _sender_address_hex         text,
    _recipient_address_hex      text,
    _amount_luna                bigint,
    _fee_luna                   bigint,
    _network_id                 integer,
    _validity_start_height      integer,
    _prepared_transaction_hash  text,
    _prepared_transaction_hex   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign record;
    _refund record;
    _vault record;
    _sender text := lower(trim(COALESCE(_sender_address_hex, '')));
    _recipient text := lower(trim(COALESCE(_recipient_address_hex, '')));
    _prepared_hash text := lower(trim(COALESCE(_prepared_transaction_hash, '')));
    _prepared_hex text := lower(trim(COALESCE(_prepared_transaction_hex, '')));
BEGIN
    SELECT r.* INTO _refund
    FROM public.reward_refunds r
    WHERE r.id = _refund_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'refund_not_found');
    END IF;

    SELECT c.id, c.poll_id, c.status, c.creator_wallet,
           c.refundable_amount_luna
    INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _refund.campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;
    IF _campaign.status <> 'refunding' THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_refunding');
    END IF;
    IF _refund.status NOT IN ('pending', 'retryable') THEN
        RETURN jsonb_build_object('result_kind', 'refund_state_conflict', 'state', _refund.status);
    END IF;
    IF _refund.transaction_hash IS NOT NULL OR _refund.broadcast_started_at IS NOT NULL THEN
        RETURN jsonb_build_object('result_kind', 'broadcast_already_started');
    END IF;

    SELECT v.vault_address_hex INTO _vault
    FROM public.reward_campaign_vaults v
    WHERE v.campaign_id = _refund.campaign_id
    FOR SHARE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'vault_not_found');
    END IF;
    IF _campaign.refundable_amount_luna <> _refund.amount_luna
       OR _refund.creator_wallet <> _campaign.creator_wallet THEN
        RETURN jsonb_build_object('result_kind', 'refund_frozen_state_conflict');
    END IF;
    IF _amount_luna IS NULL OR _amount_luna <= 0
       OR _amount_luna <> _refund.amount_luna
       OR _fee_luna IS NULL OR _fee_luna < 0
       OR _network_id IS NULL OR _network_id < 0
       OR _validity_start_height IS NULL OR _validity_start_height < 0
       OR _sender !~ '^[0-9a-f]{40}$'
       OR _recipient !~ '^[0-9a-f]{40}$'
       OR _prepared_hash !~ '^[0-9a-f]{64}$'
       OR _prepared_hex !~ '^[0-9a-f]+$'
       OR length(_prepared_hex) = 0
       OR length(_prepared_hex) % 2 <> 0 THEN
        RETURN jsonb_build_object('result_kind', 'prepared_transaction_invalid');
    END IF;
    IF _sender <> lower(_vault.vault_address_hex) THEN
        RETURN jsonb_build_object('result_kind', 'sender_mismatch');
    END IF;
    IF _recipient <> lower(_refund.creator_wallet) THEN
        RETURN jsonb_build_object('result_kind', 'recipient_mismatch');
    END IF;

    IF _refund.prepared_transaction_hash IS NOT NULL THEN
        IF _refund.prepared_transaction_hash = _prepared_hash
           AND _refund.prepared_transaction_hex = _prepared_hex
           AND lower(_refund.sender_address_hex) = _sender
           AND lower(_refund.recipient_address_hex) = _recipient
           AND _refund.amount_luna = _amount_luna
           AND _refund.fee_luna = _fee_luna
           AND _refund.network_id = _network_id
           AND _refund.validity_start_height = _validity_start_height THEN
             UPDATE public.reward_refunds
             SET status = 'pending',
                 error_code = NULL,
                 updated_at = now()
             WHERE id = _refund_id;
            RETURN jsonb_build_object('result_kind', 'replay');
        END IF;
        RETURN jsonb_build_object('result_kind', 'prepared_transaction_conflict');
    END IF;

    UPDATE public.reward_refunds
    SET sender_address_hex = _sender,
        recipient_address_hex = _recipient,
        fee_luna = _fee_luna,
        network_id = _network_id,
        validity_start_height = _validity_start_height,
        prepared_transaction_hex = _prepared_hex,
        prepared_transaction_hash = _prepared_hash,
        prepared_at = COALESCE(prepared_at, now()),
        error_code = NULL,
        updated_at = now(),
        status = 'pending'
    WHERE id = _refund_id;

    RETURN jsonb_build_object('result_kind', 'prepared');
END;
$$;

-- ==========================================================================
-- Durable broadcast-start marker and callback hash persistence
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.mark_reward_refund_broadcast_starting_atomic(
    _refund_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign record;
    _refund record;
    _campaign_id uuid;
BEGIN
    SELECT r.campaign_id INTO _campaign_id
    FROM public.reward_refunds r
    WHERE r.id = _refund_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'refund_not_found');
    END IF;

    SELECT c.status INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;
    IF _campaign.status <> 'refunding' THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_refunding');
    END IF;

    SELECT r.* INTO _refund
    FROM public.reward_refunds r
    WHERE r.id = _refund_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'refund_not_found');
    END IF;
    IF _refund.transaction_hash IS NOT NULL AND _refund.broadcast_at IS NOT NULL THEN
        RETURN jsonb_build_object('result_kind', 'replay', 'transaction_hash', _refund.transaction_hash);
    END IF;
    IF _refund.broadcast_started_at IS NOT NULL THEN
        RETURN jsonb_build_object('result_kind', 'already_started');
    END IF;
    IF _refund.status <> 'pending'
       OR _refund.prepared_transaction_hash IS NULL
       OR _refund.prepared_transaction_hex IS NULL THEN
        RETURN jsonb_build_object('result_kind', 'refund_not_prepared');
    END IF;

    UPDATE public.reward_refunds
    SET broadcast_started_at = now(),
        error_code = NULL,
        updated_at = now()
    WHERE id = _refund_id;

    RETURN jsonb_build_object('result_kind', 'started');
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_reward_refund_broadcast_atomic(
    _refund_id uuid,
    _transaction_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign record;
    _refund record;
    _campaign_id uuid;
    _hash text := lower(trim(COALESCE(_transaction_hash, '')));
BEGIN
    SELECT r.campaign_id INTO _campaign_id
    FROM public.reward_refunds r
    WHERE r.id = _refund_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'refund_not_found');
    END IF;

    SELECT c.status INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;
    IF _campaign.status <> 'refunding' THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_refunding');
    END IF;

    SELECT r.* INTO _refund
    FROM public.reward_refunds r
    WHERE r.id = _refund_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'refund_not_found');
    END IF;
    IF _hash !~ '^[0-9a-f]{64}$' THEN
        RETURN jsonb_build_object('result_kind', 'invalid_hash');
    END IF;
    IF _refund.transaction_hash IS NOT NULL AND _refund.broadcast_at IS NOT NULL THEN
        IF _refund.transaction_hash = _hash THEN
            RETURN jsonb_build_object('result_kind', 'replay', 'transaction_hash', _hash);
        END IF;
        RETURN jsonb_build_object('result_kind', 'hash_conflict');
    END IF;
    IF _refund.broadcast_started_at IS NULL
       OR _refund.status <> 'pending'
       OR _refund.prepared_transaction_hash IS NULL THEN
        RETURN jsonb_build_object('result_kind', 'refund_state_conflict');
    END IF;
    IF _refund.prepared_transaction_hash <> _hash THEN
        RETURN jsonb_build_object('result_kind', 'hash_mismatch');
    END IF;

    UPDATE public.reward_refunds
    SET transaction_hash = _hash,
        broadcast_at = now(),
        error_code = NULL,
        updated_at = now()
    WHERE id = _refund_id;

    RETURN jsonb_build_object('result_kind', 'broadcasted', 'transaction_hash', _hash);
EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object('result_kind', 'transaction_hash_conflict');
END;
$$;

-- ==========================================================================
-- Safe definite-failure and unknown-outcome persistence
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.record_reward_refund_failure_atomic(
    _refund_id uuid,
    _error_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign record;
    _refund record;
    _campaign_id uuid;
BEGIN
    SELECT r.campaign_id INTO _campaign_id
    FROM public.reward_refunds r
    WHERE r.id = _refund_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'refund_not_found');
    END IF;

    SELECT c.status INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;
    IF _campaign.status <> 'refunding' THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_refunding');
    END IF;

    SELECT r.* INTO _refund
    FROM public.reward_refunds r
    WHERE r.id = _refund_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'refund_not_found');
    END IF;
    IF _refund.broadcast_started_at IS NOT NULL OR _refund.broadcast_at IS NOT NULL THEN
        RETURN jsonb_build_object('result_kind', 'broadcast_already_started');
    END IF;
    IF _refund.status NOT IN ('pending', 'retryable') THEN
        RETURN jsonb_build_object('result_kind', 'refund_state_conflict');
    END IF;

    UPDATE public.reward_refunds
    SET status = 'retryable',
        error_code = left(COALESCE(NULLIF(trim(_error_code), ''), 'refund_prebroadcast_failed'), 64),
        updated_at = now()
    WHERE id = _refund_id;

    RETURN jsonb_build_object('result_kind', 'retryable');
END;
$$;

CREATE OR REPLACE FUNCTION public.record_reward_refund_unknown_atomic(
    _refund_id uuid,
    _error_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign record;
    _refund record;
    _campaign_id uuid;
BEGIN
    SELECT r.campaign_id INTO _campaign_id
    FROM public.reward_refunds r
    WHERE r.id = _refund_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'refund_not_found');
    END IF;

    SELECT c.status INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;
    IF _campaign.status <> 'refunding' THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_refunding');
    END IF;

    SELECT r.* INTO _refund
    FROM public.reward_refunds r
    WHERE r.id = _refund_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'refund_not_found');
    END IF;
    IF _refund.broadcast_at IS NOT NULL THEN
        RETURN jsonb_build_object('result_kind', 'replay');
    END IF;
    IF _refund.broadcast_started_at IS NULL OR _refund.status <> 'pending' THEN
        RETURN jsonb_build_object('result_kind', 'refund_state_conflict');
    END IF;

    -- Keep status pending: this is still awaiting Phase D observation/finality.
    UPDATE public.reward_refunds
    SET error_code = left(COALESCE(NULLIF(trim(_error_code), ''), 'refund_broadcast_unknown'), 64),
        updated_at = now()
    WHERE id = _refund_id;

    RETURN jsonb_build_object('result_kind', 'unknown');
END;
$$;

GRANT EXECUTE ON FUNCTION public.acquire_reward_refund_vault_lock_atomic(uuid, uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_reward_refund_transaction_atomic(uuid, text, text, bigint, bigint, integer, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_reward_refund_broadcast_starting_atomic(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_reward_refund_broadcast_atomic(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_reward_refund_failure_atomic(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_reward_refund_unknown_atomic(uuid, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.acquire_reward_refund_vault_lock_atomic(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prepare_reward_refund_transaction_atomic(uuid, text, text, bigint, bigint, integer, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_reward_refund_broadcast_starting_atomic(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_reward_refund_broadcast_atomic(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_reward_refund_failure_atomic(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_reward_refund_unknown_atomic(uuid, text) FROM PUBLIC, anon, authenticated;
