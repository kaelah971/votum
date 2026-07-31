-- Separate initiator (session wallet) from supporter (actual transaction sender).
-- Backfill: existing supporter_wallet becomes initiator_wallet.
-- Updated confirm function accepts the actual RPC sender.

-- ============================================================================
-- Add initiator_wallet to intents
-- ============================================================================

ALTER TABLE public.nim_support_intents
  ADD COLUMN initiator_wallet text;

-- Backfill: existing supporter_wallet → initiator_wallet
UPDATE public.nim_support_intents
  SET initiator_wallet = supporter_wallet
  WHERE initiator_wallet IS NULL;

ALTER TABLE public.nim_support_intents
  ALTER COLUMN initiator_wallet SET NOT NULL;

-- ============================================================================
-- Updated confirm function: accepts actual tx sender, stores it as supporter_wallet
-- ============================================================================

CREATE OR REPLACE FUNCTION public.confirm_nim_contribution_atomic(
    _intent_id         uuid,
    _transaction_hash  text,
    _block_number      bigint,
    _transaction_ts    timestamptz,
    _tx_sender         text DEFAULT NULL
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
    _supporter text;
BEGIN
    SELECT * INTO _intent
    FROM public.nim_support_intents
    WHERE id = _intent_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'intent_not_found');
    END IF;

    -- Use actual tx sender if provided, otherwise fall back to intent's current supporter_wallet
    _supporter := COALESCE(_tx_sender, _intent.supporter_wallet);

    -- Submitted lifecycle check
    IF _intent.status = 'submitted' THEN
        IF _intent.confirmation_deadline IS NOT NULL AND _intent.confirmation_deadline <= now() THEN
            UPDATE public.nim_support_intents SET status = 'expired', updated_at = now() WHERE id = _intent_id;
            RETURN jsonb_build_object('result_kind', 'intent_expired');
        END IF;
    ELSE
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

    -- Reject duplicate transaction hash
    SELECT id INTO _dup_hash FROM public.nim_contributions WHERE transaction_hash = _transaction_hash;
    IF FOUND THEN
        RETURN jsonb_build_object('result_kind', 'transaction_already_used');
    END IF;

    -- Insert contribution with actual sender
    INSERT INTO public.nim_contributions (
        intent_id, poll_id, option_id,
        supporter_wallet, recipient_wallet,
        amount_luna, transaction_hash,
        block_number, transaction_timestamp
    ) VALUES (
        _intent_id, _intent.poll_id, _intent.option_id,
        _supporter, _intent.recipient_wallet,
        _intent.amount_luna, _transaction_hash,
        _block_number, _transaction_ts
    )
    RETURNING id INTO _contrib_id;

    -- Mark confirmed
    UPDATE public.nim_support_intents
    SET status = 'confirmed', confirmed_contribution_id = _contrib_id,
        supporter_wallet = _supporter, updated_at = now()
    WHERE id = _intent_id;

    RETURN jsonb_build_object('result_kind', 'created', 'contribution_id', _contrib_id);
END;
$$;
