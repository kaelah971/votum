-- V2C.2E Poll public read cutover.
--
-- The public surface remains intentionally small.  Poll discovery enters via
-- reward_campaigns, the binding resolves the settlement, and only the root's
-- current funded offer is returned.  No vault, balance, ciphertext, or Campaign
-- product data is exposed.

CREATE OR REPLACE FUNCTION public.get_public_reward_campaign(_poll_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
    _poll record;
    _campaign record;
    _root record;
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

    SELECT c.id, c.poll_id, c.creator_wallet, b.settlement_id
    INTO _campaign
    FROM public.reward_campaigns c
    JOIN public.settlement_source_bindings b
      ON b.reward_campaign_id = c.id
     AND b.source_type = 'poll_reward_campaign'
    WHERE c.poll_id = _poll_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'not_found');
    END IF;

    SELECT s.*
    INTO _root
    FROM public.reward_settlements s
    WHERE s.id = _campaign.settlement_id;

    IF NOT FOUND OR _root.owner_wallet <> lower(trim(_campaign.creator_wallet)) THEN
        RETURN jsonb_build_object('result_kind', 'not_found');
    END IF;

    _remaining := _root.max_rewarded_participants - _root.rewarded_participant_count;
    IF _remaining < 0 THEN
        _remaining := 0;
    END IF;

    RETURN jsonb_build_object(
        'result_kind', 'found',
        'pollId', _campaign.poll_id,
        'campaignId', _campaign.id,
        'status', _root.status,
        'funded', _root.status IN ('funded', 'rewarding'),
        'rewardPerParticipantLuna', _root.reward_per_participant_luna::text,
        'maxRewardedParticipants', _root.max_rewarded_participants,
        'rewardPrincipalLuna', _root.reward_principal_luna::text,
        'rewardsRemaining', _remaining
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_reward_campaign(uuid) TO anon, authenticated, service_role;
