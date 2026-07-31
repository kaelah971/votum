-- Harden NIM support lifecycle: transaction binding, submission tracking, extended expiry.
-- Enables polling for inclusion after a transaction hash is bound to an intent.

-- ============================================================================
-- Add binding columns
-- ============================================================================

ALTER TABLE public.nim_support_intents
  ADD COLUMN submitted_transaction_hash text;

ALTER TABLE public.nim_support_intents
  ADD COLUMN submitted_at timestamptz;

ALTER TABLE public.nim_support_intents
  ADD COLUMN confirmation_deadline timestamptz;

-- Unique constraint: one transaction hash can be reserved by at most one intent
CREATE UNIQUE INDEX idx_nim_intents_submitted_hash
  ON public.nim_support_intents (submitted_transaction_hash)
  WHERE submitted_transaction_hash IS NOT NULL;

-- ============================================================================
-- Extend status values
-- ============================================================================

ALTER TABLE public.nim_support_intents
  DROP CONSTRAINT nim_support_intents_status;

ALTER TABLE public.nim_support_intents
  ADD CONSTRAINT nim_support_intents_status
    CHECK (status IN ('pending', 'submitted', 'confirmed', 'expired'));

-- ============================================================================
-- TRANSACTION BINDING FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bind_nim_support_transaction_atomic(
    _intent_id              uuid,
    _transaction_hash       text,
    _supporter_wallet       text,
    _confirmation_horizon_hours int DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    _intent    record;
    _existing  record;
    _deadline  timestamptz;
BEGIN
    SELECT * INTO _intent
    FROM public.nim_support_intents
    WHERE id = _intent_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'intent_not_found');
    END IF;

    IF _intent.supporter_wallet != _supporter_wallet THEN
        RETURN jsonb_build_object('result_kind', 'intent_not_found');
    END IF;

    -- Already bound with same hash → replay
    IF _intent.submitted_transaction_hash = _transaction_hash THEN
        RETURN jsonb_build_object('result_kind', 'bound_replay');
    END IF;

    -- Already bound with different hash
    IF _intent.submitted_transaction_hash IS NOT NULL AND _intent.submitted_transaction_hash != _transaction_hash THEN
        RETURN jsonb_build_object('result_kind', 'intent_already_bound');
    END IF;

    -- Already confirmed
    IF _intent.status = 'confirmed' THEN
        RETURN jsonb_build_object('result_kind', 'intent_already_confirmed');
    END IF;

    -- Expired
    IF _intent.status = 'expired' THEN
        RETURN jsonb_build_object('result_kind', 'intent_expired');
    END IF;

    -- Check hash not already reserved by another intent
    SELECT id INTO _existing
    FROM public.nim_support_intents
    WHERE submitted_transaction_hash = _transaction_hash;

    IF FOUND THEN
        RETURN jsonb_build_object('result_kind', 'transaction_already_reserved');
    END IF;

    -- Set confirmation deadline
    _deadline := now() + (_confirmation_horizon_hours || ' hours')::interval;

    -- Bind
    UPDATE public.nim_support_intents
    SET submitted_transaction_hash = _transaction_hash,
        submitted_at = now(),
        status = 'submitted',
        confirmation_deadline = _deadline,
        updated_at = now()
    WHERE id = _intent_id;

    RETURN jsonb_build_object(
        'result_kind', 'bound',
        'confirmation_deadline', _deadline
    );
END;
$$;

-- ============================================================================
-- Update confirmation function: check binding + handle expiry
-- ============================================================================

CREATE OR REPLACE FUNCTION public.confirm_nim_contribution_atomic(
    _intent_id         uuid,
    _transaction_hash  text,
    _block_number      bigint,
    _transaction_ts    timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    _intent    record;
    _existing  record;
    _dup_hash  record;
    _contrib_id uuid;
BEGIN
    SELECT * INTO _intent
    FROM public.nim_support_intents
    WHERE id = _intent_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'intent_not_found');
    END IF;

    -- Confirmed via binding: check submission deadline, not creation expiry
    IF _intent.status = 'submitted' THEN
        IF _intent.confirmation_deadline IS NOT NULL AND _intent.confirmation_deadline <= now() THEN
            UPDATE public.nim_support_intents
            SET status = 'expired', updated_at = now()
            WHERE id = _intent_id;
            RETURN jsonb_build_object('result_kind', 'intent_expired');
        END IF;
    ELSE
        -- Not yet submitted — use original creation expiry
        IF _intent.status = 'expired' OR _intent.expires_at <= now() THEN
            RETURN jsonb_build_object('result_kind', 'intent_expired');
        END IF;
    END IF;

    -- Must match bound hash
    IF _intent.submitted_transaction_hash IS NOT NULL AND _intent.submitted_transaction_hash != _transaction_hash THEN
        RETURN jsonb_build_object('result_kind', 'transaction_hash_mismatch');
    END IF;

    -- Already confirmed with this hash → replay
    IF _intent.status = 'confirmed' THEN
        SELECT * INTO _existing FROM public.nim_contributions WHERE intent_id = _intent_id;
        IF FOUND AND _existing.transaction_hash = _transaction_hash THEN
            RETURN jsonb_build_object('result_kind', 'replay', 'contribution_id', _existing.id);
        ELSE
            RETURN jsonb_build_object('result_kind', 'intent_already_used');
        END IF;
    END IF;

    -- Reject duplicate transaction hash globally
    SELECT id INTO _dup_hash FROM public.nim_contributions WHERE transaction_hash = _transaction_hash;
    IF FOUND THEN
        RETURN jsonb_build_object('result_kind', 'transaction_already_used');
    END IF;

    -- Insert contribution
    INSERT INTO public.nim_contributions (
        intent_id, poll_id, option_id,
        supporter_wallet, recipient_wallet,
        amount_luna, transaction_hash,
        block_number, transaction_timestamp
    ) VALUES (
        _intent_id, _intent.poll_id, _intent.option_id,
        _intent.supporter_wallet, _intent.recipient_wallet,
        _intent.amount_luna, _transaction_hash,
        _block_number, _transaction_ts
    )
    RETURNING id INTO _contrib_id;

    -- Mark intent confirmed
    UPDATE public.nim_support_intents
    SET status = 'confirmed', confirmed_contribution_id = _contrib_id, updated_at = now()
    WHERE id = _intent_id;

    RETURN jsonb_build_object('result_kind', 'created', 'contribution_id', _contrib_id);
END;
$$;

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT EXECUTE ON FUNCTION public.bind_nim_support_transaction_atomic TO service_role;
REVOKE EXECUTE ON FUNCTION public.bind_nim_support_transaction_atomic FROM PUBLIC, anon, authenticated;

-- Re-apply grants on updated function
GRANT EXECUTE ON FUNCTION public.confirm_nim_contribution_atomic TO service_role;
REVOKE EXECUTE ON FUNCTION public.confirm_nim_contribution_atomic FROM PUBLIC, anon, authenticated;
