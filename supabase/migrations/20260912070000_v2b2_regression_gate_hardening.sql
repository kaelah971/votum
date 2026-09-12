-- V2B.2.13 regression-gate hardening.
--
-- Keep legacy support and reward-first/free polls out of the reward ledger,
-- keep private campaigns out of the public read surface, and make funding hash
-- ownership canonical and case-insensitive across all financial ledgers.

-- ============================================================================
-- Reward reservations are valid only for rewarded reward-first polls.
-- ============================================================================

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

    IF _poll.economic_model IS DISTINCT FROM 'reward_first'
       OR _poll.reward_mode IS DISTINCT FROM 'rewarded' THEN
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

    IF lower(trim(_participation.voter_wallet)) = lower(trim(_poll.creator_wallet)) THEN
        RETURN jsonb_build_object(
            'result_kind', 'creator_not_reward_eligible',
            'campaign_id', _campaign.id,
            'participation_id', _participation.id
        );
    END IF;

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

-- ============================================================================
-- The public campaign read surface is limited to public live/closed polls.
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
    _poll record;
    _remaining integer;
BEGIN
    SELECT p.is_public, p.status
    INTO _poll
    FROM public.polls p
    WHERE p.id = _poll_id;

    IF NOT FOUND OR NOT COALESCE(_poll.is_public, false)
       OR _poll.status NOT IN ('live', 'closed') THEN
        RETURN jsonb_build_object('result_kind', 'not_found');
    END IF;

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

GRANT EXECUTE ON FUNCTION public.get_public_reward_campaign(uuid) TO anon, authenticated, service_role;

-- ============================================================================
-- Funding hash values are canonicalized and checked against their own ledger
-- as well as payout/refund/support ledgers.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.prevent_reward_funding_hash_reuse()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _hash text;
    _lock_key bigint;
BEGIN
    IF NEW.submitted_transaction_hash IS NOT NULL THEN
        NEW.submitted_transaction_hash := lower(trim(NEW.submitted_transaction_hash));
    END IF;
    IF NEW.confirmed_transaction_hash IS NOT NULL THEN
        NEW.confirmed_transaction_hash := lower(trim(NEW.confirmed_transaction_hash));
    END IF;

    _hash := COALESCE(NEW.submitted_transaction_hash, NEW.confirmed_transaction_hash);
    IF _hash IS NULL THEN
        RETURN NEW;
    END IF;
    IF _hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'invalid funding transaction hash'
            USING ERRCODE = 'check_violation';
    END IF;

    _lock_key := ('x' || substr(_hash, 1, 15))::bit(64)::bigint;
    IF _lock_key = 0 THEN _lock_key := 1; END IF;
    PERFORM pg_advisory_xact_lock(_lock_key);

    IF EXISTS (
        SELECT 1 FROM public.reward_funding_transactions f
        WHERE f.id <> NEW.id
          AND (
            lower(COALESCE(f.submitted_transaction_hash, '')) = _hash
            OR lower(COALESCE(f.confirmed_transaction_hash, '')) = _hash
          )
    ) OR EXISTS (
        SELECT 1 FROM public.nim_support_intents s
        WHERE lower(COALESCE(s.submitted_transaction_hash, '')) = _hash
    ) OR EXISTS (
        SELECT 1 FROM public.nim_contributions c
        WHERE lower(COALESCE(c.transaction_hash, '')) = _hash
    ) OR EXISTS (
        SELECT 1 FROM public.reward_payout_attempts p
        WHERE lower(COALESCE(p.transaction_hash, '')) = _hash
    ) OR EXISTS (
        SELECT 1 FROM public.reward_refunds r
        WHERE lower(COALESCE(r.transaction_hash, '')) = _hash
    ) THEN
        RAISE EXCEPTION 'transaction hash already belongs to another financial record'
            USING ERRCODE = 'unique_violation';
    END IF;

    RETURN NEW;
END;
$$;

GRANT EXECUTE ON FUNCTION public.prevent_reward_funding_hash_reuse TO service_role;
REVOKE EXECUTE ON FUNCTION public.prevent_reward_funding_hash_reuse FROM PUBLIC, anon, authenticated;
