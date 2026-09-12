-- V2B.2.8 — safe retry creation for definite pre-broadcast failures.
-- Hash-bearing attempts must be reconciled first; this function never blindly
-- resends an existing signed transaction.

CREATE OR REPLACE FUNCTION public.retry_reward_payout_atomic(
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
    _attempt record;
    _next_attempt_number integer;
BEGIN
    SELECT r.*
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
    IF NOT FOUND OR _receipt.poll_id <> _campaign.poll_id THEN
        RETURN jsonb_build_object('result_kind', 'receipt_campaign_mismatch');
    END IF;

    IF _receipt.status = 'paid' THEN
        RETURN jsonb_build_object('result_kind', 'receipt_paid');
    END IF;
    IF _receipt.status <> 'retryable' THEN
        RETURN jsonb_build_object('result_kind', 'payout_state_conflict');
    END IF;

    SELECT a.*
    INTO _attempt
    FROM public.reward_payout_attempts a
    WHERE a.receipt_id = _receipt.id
    ORDER BY a.attempt_number DESC
    LIMIT 1
    FOR UPDATE;
    IF NOT FOUND OR _attempt.status <> 'retryable' THEN
        RETURN jsonb_build_object('result_kind', 'payout_state_conflict');
    END IF;

    IF _attempt.transaction_hash IS NOT NULL
       OR _attempt.broadcast_started_at IS NOT NULL
       OR _attempt.broadcast_at IS NOT NULL THEN
        RETURN jsonb_build_object('result_kind', 'reconciliation_required');
    END IF;

    IF _attempt.attempt_number >= 5 THEN
        RETURN jsonb_build_object('result_kind', 'retry_limit_reached');
    END IF;

    _next_attempt_number := _attempt.attempt_number + 1;
    INSERT INTO public.reward_payout_attempts (receipt_id, attempt_number, status)
    VALUES (_receipt.id, _next_attempt_number, 'pending')
    RETURNING * INTO _attempt;

    UPDATE public.reward_receipts
    SET status = 'payout_pending', updated_at = now()
    WHERE id = _receipt.id AND status = 'retryable';

    RETURN jsonb_build_object(
        'result_kind', 'retryable',
        'attempt_id', _attempt.id,
        'receipt_id', _receipt.id,
        'campaign_id', _campaign.id,
        'attempt_number', _attempt.attempt_number,
        'attempt_status', _attempt.status,
        'receipt_status', 'payout_pending',
        'participant_wallet', _receipt.participant_wallet,
        'amount_luna', _receipt.amount_luna::text
    );
EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object('result_kind', 'payout_attempt_conflict');
END;
$$;

GRANT EXECUTE ON FUNCTION public.retry_reward_payout_atomic(uuid, uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.retry_reward_payout_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
