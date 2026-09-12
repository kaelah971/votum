-- V2B.2.7 — server-signed, server-broadcast reserved reward payouts.
--
-- This migration intentionally stops at a broadcast callback. `pending` means
-- prepared or broadcast outcome unresolved; it never means chain-paid. The
-- later reconciliation migration owns observation and the paid transition.

-- ==========================================================================
-- Durable prepared transaction and broadcast boundary
-- ==========================================================================

ALTER TABLE public.reward_payout_attempts
  ADD COLUMN IF NOT EXISTS sender_address_hex text,
  ADD COLUMN IF NOT EXISTS recipient_address_hex text,
  ADD COLUMN IF NOT EXISTS amount_luna bigint,
  ADD COLUMN IF NOT EXISTS fee_luna bigint,
  ADD COLUMN IF NOT EXISTS network_id integer,
  ADD COLUMN IF NOT EXISTS validity_start_height integer,
  ADD COLUMN IF NOT EXISTS prepared_transaction_hex text,
  ADD COLUMN IF NOT EXISTS prepared_at timestamptz,
  ADD COLUMN IF NOT EXISTS broadcast_started_at timestamptz;

ALTER TABLE public.reward_payout_attempts
  ADD CONSTRAINT reward_payout_hash_format
    CHECK (transaction_hash IS NULL OR transaction_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE public.reward_payout_attempts
  ADD CONSTRAINT reward_payout_prepared_amount_nonneg
    CHECK (amount_luna IS NULL OR amount_luna > 0),
  ADD CONSTRAINT reward_payout_prepared_fee_nonneg
    CHECK (fee_luna IS NULL OR fee_luna >= 0),
  ADD CONSTRAINT reward_payout_prepared_network_nonneg
    CHECK (network_id IS NULL OR network_id >= 0),
  ADD CONSTRAINT reward_payout_prepared_height_nonneg
    CHECK (validity_start_height IS NULL OR validity_start_height >= 0),
  ADD CONSTRAINT reward_payout_prepared_hex_format
    CHECK (
      prepared_transaction_hex IS NULL
      OR (
        length(prepared_transaction_hex) > 0
        AND prepared_transaction_hex ~ '^[0-9a-f]+$'
        AND length(prepared_transaction_hex) % 2 = 0
      )
    ),
  ADD CONSTRAINT reward_payout_prepared_fields_complete
    CHECK (
      prepared_transaction_hex IS NULL
      OR (
        transaction_hash IS NOT NULL
        AND sender_address_hex IS NOT NULL
        AND recipient_address_hex IS NOT NULL
        AND amount_luna IS NOT NULL
        AND fee_luna IS NOT NULL
        AND network_id IS NOT NULL
        AND validity_start_height IS NOT NULL
        AND prepared_at IS NOT NULL
      )
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_payout_active_receipt
  ON public.reward_payout_attempts (receipt_id)
  WHERE status IN ('pending', 'confirmed');

-- ==========================================================================
-- Campaign-scoped lease: one campaign has one isolated reward vault.
-- A lease is used because a PostgreSQL transaction/advisory lock cannot span
-- the external Nimiq network call made by the application server.
-- ==========================================================================

ALTER TABLE public.reward_campaigns
  ADD COLUMN IF NOT EXISTS payout_lock_attempt_id uuid,
  ADD COLUMN IF NOT EXISTS payout_lock_token text,
  ADD COLUMN IF NOT EXISTS payout_lock_expires_at timestamptz;

ALTER TABLE public.reward_campaigns
  ADD CONSTRAINT reward_campaigns_payout_lock_token_not_empty
    CHECK (payout_lock_token IS NULL OR length(trim(payout_lock_token)) > 0);

-- ==========================================================================
-- Cross-ledger transaction-hash guard for prepared payout hashes.
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.prevent_reward_payout_hash_reuse()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _hash text;
    _lock_key bigint;
BEGIN
    IF NEW.transaction_hash IS NULL THEN
        RETURN NEW;
    END IF;

    _hash := lower(trim(NEW.transaction_hash));
    _lock_key := ('x' || substr(_hash, 1, 15))::bit(64)::bigint;
    IF _lock_key = 0 THEN _lock_key := 1; END IF;
    PERFORM pg_advisory_xact_lock(_lock_key);

    IF EXISTS (
        SELECT 1 FROM public.reward_payout_attempts p
        WHERE p.transaction_hash = _hash AND p.id <> NEW.id
    ) OR EXISTS (
        SELECT 1 FROM public.reward_funding_transactions f
        WHERE f.submitted_transaction_hash = _hash
           OR f.confirmed_transaction_hash = _hash
    ) OR EXISTS (
        SELECT 1 FROM public.nim_support_intents s
        WHERE s.submitted_transaction_hash = _hash
    ) OR EXISTS (
        SELECT 1 FROM public.nim_contributions c
        WHERE c.transaction_hash = _hash
    ) OR EXISTS (
        SELECT 1 FROM public.reward_refunds r
        WHERE r.transaction_hash = _hash
    ) THEN
        RAISE EXCEPTION 'transaction hash already belongs to another financial record'
            USING ERRCODE = 'unique_violation';
    END IF;

    NEW.transaction_hash := _hash;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reward_payout_hash_reuse_guard
  ON public.reward_payout_attempts;

CREATE TRIGGER reward_payout_hash_reuse_guard
  BEFORE INSERT OR UPDATE OF transaction_hash
  ON public.reward_payout_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_reward_payout_hash_reuse();

GRANT EXECUTE ON FUNCTION public.prevent_reward_payout_hash_reuse TO service_role;
REVOKE EXECUTE ON FUNCTION public.prevent_reward_payout_hash_reuse FROM PUBLIC, anon, authenticated;

-- ==========================================================================
-- Common safe payout snapshot shape is returned by the claim RPC.
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.begin_reward_payout_atomic(
    _receipt_id  uuid,
    _campaign_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _receipt record;
    _campaign record;
    _vault record;
    _attempt record;
    _attempt_number integer;
BEGIN
    -- Receipt is the first lock in every payout claim. Campaign/vault is then
    -- locked in the same order by all payout writers, avoiding stale claims.
    SELECT r.id, r.campaign_id, r.poll_id, r.participant_wallet,
           r.amount_luna, r.status
    INTO _receipt
    FROM public.reward_receipts r
    WHERE r.id = _receipt_id
      AND r.campaign_id = _campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'receipt_not_found');
    END IF;

    SELECT c.id, c.poll_id, c.status
    INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;

    IF NOT FOUND OR _receipt.campaign_id <> _campaign.id
       OR _receipt.poll_id <> _campaign.poll_id THEN
        RETURN jsonb_build_object('result_kind', 'receipt_campaign_mismatch');
    END IF;

    IF _receipt.status = 'paid' THEN
        RETURN jsonb_build_object('result_kind', 'receipt_paid');
    END IF;

    IF _receipt.status IN ('failed', 'retryable') THEN
        RETURN jsonb_build_object(
            'result_kind', 'receipt_state_conflict',
            'state', _receipt.status
        );
    END IF;

    SELECT a.* INTO _attempt
    FROM public.reward_payout_attempts a
    WHERE a.receipt_id = _receipt.id
    ORDER BY a.attempt_number DESC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
        IF _receipt.status = 'payout_pending' AND _attempt.status = 'pending' THEN
            RETURN jsonb_build_object(
                'result_kind', 'replay',
                'attempt_id', _attempt.id,
                'receipt_id', _receipt.id,
                'campaign_id', _receipt.campaign_id,
                'attempt_number', _attempt.attempt_number,
                'attempt_status', _attempt.status,
                'receipt_status', _receipt.status,
                'participant_wallet', _receipt.participant_wallet,
                'amount_luna', _receipt.amount_luna::text,
                'vault_address_hex', (SELECT v.vault_address_hex FROM public.reward_campaign_vaults v WHERE v.campaign_id = _receipt.campaign_id),
                'prepared_transaction_hex', _attempt.prepared_transaction_hex,
                'transaction_hash', _attempt.transaction_hash,
                'sender_address_hex', _attempt.sender_address_hex,
                'recipient_address_hex', _attempt.recipient_address_hex,
                'fee_luna', _attempt.fee_luna::text,
                'network_id', _attempt.network_id,
                'validity_start_height', _attempt.validity_start_height,
                'prepared_at', _attempt.prepared_at,
                'broadcast_started_at', _attempt.broadcast_started_at,
                'broadcast_at', _attempt.broadcast_at
            );
        END IF;
        RETURN jsonb_build_object('result_kind', 'payout_state_inconsistent');
    END IF;

    IF _receipt.status <> 'reserved' THEN
        RETURN jsonb_build_object(
            'result_kind', 'receipt_not_reserved',
            'state', _receipt.status
        );
    END IF;

    IF _campaign.status NOT IN ('rewarding', 'exhausted') THEN
        RETURN jsonb_build_object(
            'result_kind', 'campaign_not_rewarding',
            'state', _campaign.status
        );
    END IF;

    SELECT v.vault_address_hex INTO _vault
    FROM public.reward_campaign_vaults v
    WHERE v.campaign_id = _campaign.id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'vault_not_found');
    END IF;

    SELECT COALESCE(MAX(a.attempt_number), 0) + 1
    INTO _attempt_number
    FROM public.reward_payout_attempts a
    WHERE a.receipt_id = _receipt.id;

    INSERT INTO public.reward_payout_attempts (receipt_id, attempt_number, status)
    VALUES (_receipt.id, _attempt_number, 'pending')
    RETURNING * INTO _attempt;

    UPDATE public.reward_receipts
    SET status = 'payout_pending', updated_at = now()
    WHERE id = _receipt.id AND status = 'reserved';

    RETURN jsonb_build_object(
        'result_kind', 'created',
        'attempt_id', _attempt.id,
        'receipt_id', _receipt.id,
        'campaign_id', _receipt.campaign_id,
        'attempt_number', _attempt.attempt_number,
        'attempt_status', _attempt.status,
        'receipt_status', 'payout_pending',
        'participant_wallet', _receipt.participant_wallet,
        'amount_luna', _receipt.amount_luna::text,
        'vault_address_hex', _vault.vault_address_hex,
        'prepared_transaction_hex', NULL,
        'transaction_hash', NULL,
        'sender_address_hex', NULL,
        'recipient_address_hex', NULL,
        'fee_luna', NULL,
        'network_id', NULL,
        'validity_start_height', NULL,
        'prepared_at', NULL,
        'broadcast_started_at', NULL,
        'broadcast_at', NULL
    );
EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object('result_kind', 'payout_attempt_conflict');
END;
$$;

GRANT EXECUTE ON FUNCTION public.begin_reward_payout_atomic(uuid, uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.begin_reward_payout_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ==========================================================================
-- Persist signed bytes/hash before the irreversible network call.
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.prepare_reward_payout_atomic(
    _attempt_id               uuid,
    _sender_address_hex       text,
    _recipient_address_hex    text,
    _amount_luna              bigint,
    _fee_luna                 bigint,
    _network_id               integer,
    _validity_start_height    integer,
    _transaction_hash         text,
    _prepared_transaction_hex text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _attempt record;
    _hash text := lower(trim(_transaction_hash));
BEGIN
    SELECT a.*, r.campaign_id, r.participant_wallet, r.amount_luna AS receipt_amount,
           r.status AS receipt_status, v.vault_address_hex
    INTO _attempt
    FROM public.reward_payout_attempts a
    JOIN public.reward_receipts r ON r.id = a.receipt_id
    JOIN public.reward_campaign_vaults v ON v.campaign_id = r.campaign_id
    WHERE a.id = _attempt_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'attempt_not_found');
    END IF;

    IF _attempt.status <> 'pending' OR _attempt.receipt_status <> 'payout_pending' THEN
        RETURN jsonb_build_object('result_kind', 'attempt_state_conflict');
    END IF;

    IF _attempt.broadcast_started_at IS NOT NULL OR _attempt.broadcast_at IS NOT NULL THEN
        RETURN jsonb_build_object('result_kind', 'broadcast_already_started');
    END IF;

    IF _attempt.prepared_transaction_hex IS NOT NULL THEN
        IF _attempt.transaction_hash = _hash
           AND lower(_attempt.sender_address_hex) = lower(trim(_sender_address_hex))
           AND lower(_attempt.recipient_address_hex) = lower(trim(_recipient_address_hex))
           AND _attempt.amount_luna = _amount_luna
           AND _attempt.fee_luna = _fee_luna
           AND _attempt.network_id = _network_id
           AND _attempt.validity_start_height = _validity_start_height
           AND _attempt.prepared_transaction_hex = lower(trim(_prepared_transaction_hex)) THEN
            RETURN jsonb_build_object('result_kind', 'replay');
        END IF;
        RETURN jsonb_build_object('result_kind', 'prepared_transaction_conflict');
    END IF;

    IF _hash !~ '^[0-9a-f]{64}$'
       OR _prepared_transaction_hex IS NULL
       OR trim(_prepared_transaction_hex) !~ '^[0-9a-f]+$'
       OR length(trim(_prepared_transaction_hex)) = 0
       OR length(trim(_prepared_transaction_hex)) % 2 <> 0
       OR _sender_address_hex IS NULL
       OR _recipient_address_hex IS NULL
       OR _amount_luna IS NULL OR _amount_luna <= 0
       OR _fee_luna IS NULL OR _fee_luna < 0
       OR _network_id IS NULL OR _network_id < 0
       OR _validity_start_height IS NULL OR _validity_start_height < 0 THEN
        RETURN jsonb_build_object('result_kind', 'prepared_transaction_invalid');
    END IF;

    IF _amount_luna <> _attempt.receipt_amount THEN
        RETURN jsonb_build_object('result_kind', 'amount_mismatch');
    END IF;
    IF lower(trim(_recipient_address_hex)) <> lower(trim(_attempt.participant_wallet)) THEN
        RETURN jsonb_build_object('result_kind', 'recipient_mismatch');
    END IF;
    IF lower(trim(_sender_address_hex)) <> lower(trim(_attempt.vault_address_hex)) THEN
        RETURN jsonb_build_object('result_kind', 'sender_mismatch');
    END IF;

    UPDATE public.reward_payout_attempts
    SET sender_address_hex = lower(trim(_sender_address_hex)),
        recipient_address_hex = lower(trim(_recipient_address_hex)),
        amount_luna = _amount_luna,
        fee_luna = _fee_luna,
        network_id = _network_id,
        validity_start_height = _validity_start_height,
        prepared_transaction_hex = lower(trim(_prepared_transaction_hex)),
        transaction_hash = _hash,
        prepared_at = now(),
        updated_at = now()
    WHERE id = _attempt_id;

    RETURN jsonb_build_object('result_kind', 'prepared');
EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object('result_kind', 'transaction_hash_conflict');
END;
$$;

GRANT EXECUTE ON FUNCTION public.prepare_reward_payout_atomic(uuid, text, text, bigint, bigint, integer, integer, text, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.prepare_reward_payout_atomic(uuid, text, text, bigint, bigint, integer, integer, text, text) FROM PUBLIC, anon, authenticated;

-- ==========================================================================
-- Durable pre-call marker and broadcast callback persistence.
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.mark_reward_payout_broadcast_starting(
    _attempt_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _attempt record;
BEGIN
    SELECT * INTO _attempt
    FROM public.reward_payout_attempts
    WHERE id = _attempt_id
    FOR UPDATE;

    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind', 'attempt_not_found'); END IF;
    IF _attempt.broadcast_started_at IS NOT NULL OR _attempt.broadcast_at IS NOT NULL THEN
        RETURN jsonb_build_object('result_kind', 'replay');
    END IF;
    IF _attempt.status <> 'pending' OR _attempt.prepared_transaction_hex IS NULL
       OR _attempt.transaction_hash IS NULL THEN
        RETURN jsonb_build_object('result_kind', 'attempt_not_prepared');
    END IF;

    UPDATE public.reward_payout_attempts
    SET broadcast_started_at = now(), updated_at = now()
    WHERE id = _attempt_id;
    RETURN jsonb_build_object('result_kind', 'started');
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_reward_payout_broadcast_starting(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.mark_reward_payout_broadcast_starting(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.mark_reward_payout_broadcast_atomic(
    _attempt_id       uuid,
    _transaction_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _attempt record;
    _hash text := lower(trim(_transaction_hash));
BEGIN
    SELECT * INTO _attempt
    FROM public.reward_payout_attempts
    WHERE id = _attempt_id
    FOR UPDATE;

    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind', 'attempt_not_found'); END IF;
    IF _hash !~ '^[0-9a-f]{64}$' OR _attempt.transaction_hash <> _hash THEN
        RETURN jsonb_build_object('result_kind', 'hash_mismatch');
    END IF;
    IF _attempt.broadcast_at IS NOT NULL THEN
        RETURN jsonb_build_object('result_kind', 'replay');
    END IF;
    IF _attempt.broadcast_started_at IS NULL OR _attempt.status <> 'pending' THEN
        RETURN jsonb_build_object('result_kind', 'attempt_state_conflict');
    END IF;

    -- Leave status pending. This hash is a broadcast callback, not proof of
    -- execution, canonical inclusion, macro finality, or payment.
    UPDATE public.reward_payout_attempts
    SET broadcast_at = now(), error_code = NULL, updated_at = now()
    WHERE id = _attempt_id;
    RETURN jsonb_build_object('result_kind', 'broadcasted', 'transaction_hash', _hash);
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_reward_payout_broadcast_atomic(uuid, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.mark_reward_payout_broadcast_atomic(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_reward_payout_failure_atomic(
    _attempt_id uuid,
    _error_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _attempt record;
BEGIN
    SELECT a.*, r.status AS receipt_status
    INTO _attempt
    FROM public.reward_payout_attempts a
    JOIN public.reward_receipts r ON r.id = a.receipt_id
    WHERE a.id = _attempt_id
    FOR UPDATE;

    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind', 'attempt_not_found'); END IF;
    IF _attempt.broadcast_at IS NOT NULL OR _attempt.status <> 'pending' THEN
        RETURN jsonb_build_object('result_kind', 'replay');
    END IF;

    UPDATE public.reward_payout_attempts
    SET status = 'retryable',
        error_code = left(COALESCE(NULLIF(trim(_error_code), ''), 'payout_failed'), 64),
        updated_at = now()
    WHERE id = _attempt_id;

    UPDATE public.reward_receipts
    SET status = 'retryable', updated_at = now()
    WHERE id = _attempt.receipt_id AND status = 'payout_pending';

    RETURN jsonb_build_object('result_kind', 'retryable');
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_reward_payout_failure_atomic(uuid, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.record_reward_payout_failure_atomic(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_reward_payout_unknown_atomic(
    _attempt_id uuid,
    _error_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _attempt record;
BEGIN
    SELECT * INTO _attempt
    FROM public.reward_payout_attempts
    WHERE id = _attempt_id
    FOR UPDATE;

    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind', 'attempt_not_found'); END IF;
    IF _attempt.broadcast_at IS NOT NULL THEN RETURN jsonb_build_object('result_kind', 'replay'); END IF;
    IF _attempt.status <> 'pending' OR _attempt.broadcast_started_at IS NULL THEN
        RETURN jsonb_build_object('result_kind', 'attempt_state_conflict');
    END IF;

    UPDATE public.reward_payout_attempts
    SET error_code = left(COALESCE(NULLIF(trim(_error_code), ''), 'broadcast_unknown'), 64),
        updated_at = now()
    WHERE id = _attempt_id;
    RETURN jsonb_build_object('result_kind', 'unknown');
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_reward_payout_unknown_atomic(uuid, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.record_reward_payout_unknown_atomic(uuid, text) FROM PUBLIC, anon, authenticated;

-- ==========================================================================
-- Campaign/vault lease held across construction and Nimiq broadcast.
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.acquire_reward_payout_vault_lock_atomic(
    _campaign_id  uuid,
    _attempt_id   uuid,
    _lock_token   text,
    _lease_seconds integer DEFAULT 120
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign record;
    _attempt_campaign uuid;
    _lease integer := GREATEST(30, LEAST(COALESCE(_lease_seconds, 120), 600));
BEGIN
    SELECT c.payout_lock_attempt_id, c.payout_lock_token, c.payout_lock_expires_at
    INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind', 'campaign_not_found'); END IF;

    SELECT r.campaign_id INTO _attempt_campaign
    FROM public.reward_payout_attempts a
    JOIN public.reward_receipts r ON r.id = a.receipt_id
    WHERE a.id = _attempt_id;
    IF NOT FOUND OR _attempt_campaign <> _campaign_id THEN
        RETURN jsonb_build_object('result_kind', 'attempt_campaign_mismatch');
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
    SET payout_lock_attempt_id = _attempt_id,
        payout_lock_token = _lock_token,
        payout_lock_expires_at = now() + (_lease || ' seconds')::interval,
        updated_at = now()
    WHERE id = _campaign_id;
    RETURN jsonb_build_object('result_kind', 'acquired');
END;
$$;

GRANT EXECUTE ON FUNCTION public.acquire_reward_payout_vault_lock_atomic(uuid, uuid, text, integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.acquire_reward_payout_vault_lock_atomic(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.release_reward_payout_vault_lock_atomic(
    _campaign_id uuid,
    _lock_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE public.reward_campaigns
    SET payout_lock_attempt_id = NULL,
        payout_lock_token = NULL,
        payout_lock_expires_at = NULL,
        updated_at = now()
    WHERE id = _campaign_id AND payout_lock_token = _lock_token;
    RETURN jsonb_build_object('result_kind', 'released');
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_reward_payout_vault_lock_atomic(uuid, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.release_reward_payout_vault_lock_atomic(uuid, text) FROM PUBLIC, anon, authenticated;
