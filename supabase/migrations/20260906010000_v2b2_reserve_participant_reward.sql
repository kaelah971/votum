-- V2B.2.6 Phase B — atomically reserve one participant reward.
--
-- The participation row is the only participant input. The RPC derives the
-- wallet, poll, creator, reward amount, and campaign terms from persisted data.
-- This boundary creates a reserved receipt only; payout execution is later.

CREATE OR REPLACE FUNCTION public.claim_reward_receipt_atomic(
    _participation_id uuid,
    _campaign_id     uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _participation record;
    _poll          record;
    _campaign      record;
    _existing      record;
    _receipt_id    uuid;
    _now           timestamptz := now();
    _next_count    integer;
    _next_status   text;
BEGIN
    IF _participation_id IS NULL THEN
        RETURN jsonb_build_object('result_kind', 'participation_not_found');
    END IF;

    IF _campaign_id IS NULL THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;

    -- Every reservation for a campaign serializes on this row. This makes the
    -- capacity check, receipt insert, counter increment, and state transition
    -- one transaction even when the final slot is claimed concurrently.
    SELECT c.*
    INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;

    SELECT v.id, v.poll_id, v.voter_wallet
    INTO _participation
    FROM public.poll_votes v
    WHERE v.id = _participation_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'participation_not_found');
    END IF;

    IF _participation.poll_id <> _campaign.poll_id THEN
        RETURN jsonb_build_object(
            'result_kind', 'participation_poll_mismatch',
            'campaign_id', _campaign.id,
            'participation_id', _participation.id
        );
    END IF;

    SELECT p.id, p.creator_wallet, p.economic_model, p.reward_mode,
           p.is_public, p.status
    INTO _poll
    FROM public.polls p
    WHERE p.id = _participation.poll_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'participation_not_found');
    END IF;

    IF NOT _poll.is_public OR _poll.status NOT IN ('live', 'closed') THEN
        RETURN jsonb_build_object(
            'result_kind', 'poll_not_public',
            'campaign_id', _campaign.id
        );
    END IF;

    IF _poll.economic_model = 'reward_first'
       AND _poll.reward_mode IS DISTINCT FROM 'rewarded' THEN
        RETURN jsonb_build_object(
            'result_kind', 'poll_not_rewarded',
            'campaign_id', _campaign.id
        );
    END IF;

    IF _campaign.creator_wallet IS NULL
       OR lower(trim(_campaign.creator_wallet)) <> lower(trim(_poll.creator_wallet)) THEN
        RETURN jsonb_build_object(
            'result_kind', 'campaign_not_reservable',
            'campaign_id', _campaign.id
        );
    END IF;

    IF _campaign.status IN ('configured', 'funding_pending') THEN
        RETURN jsonb_build_object(
            'result_kind', 'campaign_not_funded',
            'campaign_id', _campaign.id
        );
    END IF;

    IF _campaign.status NOT IN ('funded', 'rewarding', 'exhausted') THEN
        RETURN jsonb_build_object(
            'result_kind', 'campaign_not_reservable',
            'campaign_id', _campaign.id
        );
    END IF;

    IF _campaign.reward_per_participant_luna < 1000
       OR _campaign.max_rewarded_participants <= 0
       OR _campaign.rewarded_participant_count < 0
       OR _campaign.rewarded_participant_count > _campaign.max_rewarded_participants THEN
        RETURN jsonb_build_object(
            'result_kind', 'campaign_not_reservable',
            'campaign_id', _campaign.id
        );
    END IF;

    -- Creator participation remains a valid vote but never creates a reward.
    IF lower(trim(_participation.voter_wallet)) = lower(trim(_poll.creator_wallet)) THEN
        RETURN jsonb_build_object(
            'result_kind', 'creator_not_reward_eligible',
            'campaign_id', _campaign.id,
            'participation_id', _participation.id
        );
    END IF;

    -- Check idempotency before capacity. A replay must return its original
    -- receipt even when the campaign has since exhausted its remaining slots.
    SELECT r.id, r.amount_luna, r.status
    INTO _existing
    FROM public.reward_receipts r
    WHERE r.campaign_id = _campaign.id
      AND lower(trim(r.participant_wallet)) = lower(trim(_participation.voter_wallet));

    IF FOUND THEN
        RETURN jsonb_build_object(
            'result_kind', 'replay',
            'receipt_id', _existing.id,
            'campaign_id', _campaign.id,
            'poll_id', _campaign.poll_id,
            'participant_wallet', _participation.voter_wallet,
            'amount_luna', _existing.amount_luna,
            'status', _existing.status
        );
    END IF;

    IF _campaign.status = 'exhausted'
       OR _campaign.rewarded_participant_count >= _campaign.max_rewarded_participants THEN
        RETURN jsonb_build_object(
            'result_kind', 'no_reward_capacity',
            'campaign_id', _campaign.id
        );
    END IF;

    _next_count := _campaign.rewarded_participant_count + 1;
    _next_status := CASE
        WHEN _next_count >= _campaign.max_rewarded_participants THEN 'exhausted'
        ELSE 'rewarding'
    END;

    -- Keep the unique index as a second idempotency defense for service-side
    -- callers that might write receipt rows outside this RPC.
    INSERT INTO public.reward_receipts (
        campaign_id,
        poll_id,
        participant_wallet,
        amount_luna,
        status
    ) VALUES (
        _campaign.id,
        _campaign.poll_id,
        _participation.voter_wallet,
        _campaign.reward_per_participant_luna,
        'reserved'
    )
    ON CONFLICT (campaign_id, participant_wallet) DO NOTHING
    RETURNING id INTO _receipt_id;

    IF _receipt_id IS NULL THEN
        SELECT r.id, r.amount_luna, r.status
        INTO _existing
        FROM public.reward_receipts r
        WHERE r.campaign_id = _campaign.id
          AND lower(trim(r.participant_wallet)) = lower(trim(_participation.voter_wallet));

        RETURN jsonb_build_object(
            'result_kind', 'replay',
            'receipt_id', _existing.id,
            'campaign_id', _campaign.id,
            'poll_id', _campaign.poll_id,
            'participant_wallet', _participation.voter_wallet,
            'amount_luna', _existing.amount_luna,
            'status', _existing.status
        );
    END IF;

    UPDATE public.reward_campaigns
    SET rewarded_participant_count = _next_count,
        status = _next_status,
        first_reservation_at = COALESCE(first_reservation_at, _now),
        updated_at = _now
    WHERE id = _campaign.id;

    RETURN jsonb_build_object(
        'result_kind', 'reserved',
        'receipt_id', _receipt_id,
        'campaign_id', _campaign.id,
        'poll_id', _campaign.poll_id,
        'participation_id', _participation.id,
        'participant_wallet', _participation.voter_wallet,
        'amount_luna', _campaign.reward_per_participant_luna,
        'status', 'reserved',
        'campaign_status', _next_status,
        'rewarded_participant_count', _next_count,
        'rewards_remaining', _campaign.max_rewarded_participants - _next_count
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_reward_receipt_atomic(uuid, uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.claim_reward_receipt_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
