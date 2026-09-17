-- V2C.3D Phase 2 authoritative atomic Public Giveaway claim reservation.
--
-- claim_campaign_reward_atomic executes the exact spec Section 6 ordering in
-- ONE database transaction: lock settlement, lock and recheck the presented
-- challenge, replay-before-capacity, full eligibility recheck, receipt
-- insert with ON CONFLICT fallback to replay, counter and lifecycle
-- transition with exactly-once first_reservation_at, challenge consumption,
-- single commit.
--
-- consumed_at means ONLY "consumed by this authoritative successful atomic
-- claim/reservation transaction". Any validation or reservation failure
-- leaves no receipt, no counter movement, and consumed_at NULL. No payout
-- is created here; the caller enqueues the existing automatic payout path
-- outside this commit, exactly as the Poll path does.
--
-- Signature cryptography is verified route-side before this mutation (the C
-- library, verification only, no consumption). This function rechecks
-- challenge binding, expiry, and consumption under lock. All economics
-- (amount, capacity, vault, lifecycle) load from locked server rows; the
-- caller supplies identity only (campaign, canonical wallet, challenge).

CREATE FUNCTION public.claim_campaign_reward_atomic(
    _campaign_id uuid,
    _participant_wallet text,
    _challenge_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    _campaign record;
    _root record;
    _challenge record;
    _existing record;
    _receipt_id uuid;
    _wallet text := lower(trim(COALESCE(_participant_wallet, '')));
    _next integer;
    _next_status text;
    _now timestamptz := now();
BEGIN
    IF _wallet !~ '^[0-9a-f]{40}$' THEN
        RETURN jsonb_build_object('result_kind', 'challenge_invalid');
    END IF;

    -- (1) Campaign existence, then settlement lock, then binding recheck.
    -- The settlement lock serializes capacity decisions; it is taken before
    -- any other row lock in every claim transaction.
    SELECT * INTO _campaign FROM public.participation_campaigns WHERE id = _campaign_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;
    SELECT * INTO _root FROM public.reward_settlements WHERE id = _campaign.settlement_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.settlement_source_bindings b
        WHERE b.settlement_id = _root.id
          AND b.source_type = 'participation_campaign'
          AND b.participation_campaign_id = _campaign.id
    ) THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;

    -- (2) Challenge lock and recheck under lock: binding, wallet, scope,
    -- expiry against database time. The single-use check is intentionally
    -- deferred until after the replay lookup: retrying the exact successful
    -- request must return the existing receipt even though the presented
    -- challenge is already consumed (spec Section 6 step 5: consume only if
    -- still unconsumed).
    SELECT * INTO _challenge FROM public.campaign_claim_challenges WHERE id = _challenge_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'challenge_invalid');
    END IF;
    IF _challenge.campaign_id IS DISTINCT FROM _campaign.id
       OR _challenge.participant_wallet IS DISTINCT FROM _wallet
       OR _challenge.action <> 'campaign_claim'
       OR _challenge.version <> 1 THEN
        RETURN jsonb_build_object('result_kind', 'challenge_invalid');
    END IF;
    IF _challenge.expires_at <= _now THEN
        RETURN jsonb_build_object('result_kind', 'challenge_expired');
    END IF;

    -- (3) Existing-entitlement lookup BEFORE capacity: duplicates take the
    -- durable replay path without touching capacity, counters, or financial
    -- status. The presented challenge is consumed only if still unconsumed,
    -- in the same commit, so a fresh challenge for an already-reserved
    -- wallet replays AND is consumed atomically (and can never authorize a
    -- second entitlement), while retrying an already-consumed challenge
    -- still replays the original receipt.
    SELECT r.id, r.amount_luna, r.status INTO _existing FROM public.reward_receipts r
    WHERE r.settlement_id = _root.id AND lower(trim(r.participant_wallet)) = _wallet;
    IF FOUND THEN
        UPDATE public.campaign_claim_challenges SET consumed_at = _now
        WHERE id = _challenge.id AND consumed_at IS NULL;
        RETURN jsonb_build_object('result_kind', 'replay', 'receipt_id', _existing.id,
          'campaign_id', _campaign.id, 'settlement_id', _root.id,
          'participant_wallet', _wallet, 'amount_luna', _existing.amount_luna, 'status', _existing.status);
    END IF;

    -- (3b) No entitlement exists, so a consumed challenge is single-use
    -- exhausted and must fail closed without side effects.
    IF _challenge.consumed_at IS NOT NULL THEN
        RETURN jsonb_build_object('result_kind', 'challenge_consumed');
    END IF;

    -- (4) Full eligibility recheck from freshly locked rows.
    IF _campaign.campaign_type <> 'public_giveaway' THEN
        RETURN jsonb_build_object('result_kind', 'unsupported_type');
    END IF;
    IF _campaign.status = 'draft' THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_published');
    ELSIF _campaign.status = 'cancelled' OR _campaign.status = 'closed' THEN
        RETURN jsonb_build_object('result_kind', 'campaign_closed');
    ELSIF _campaign.status = 'expired' THEN
        RETURN jsonb_build_object('result_kind', 'claim_ended');
    ELSIF _campaign.status <> 'published' THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_published');
    END IF;
    IF _campaign.starts_at IS NOT NULL AND _now < _campaign.starts_at THEN
        RETURN jsonb_build_object('result_kind', 'claim_not_started');
    END IF;
    IF _campaign.ends_at IS NOT NULL AND _now >= _campaign.ends_at THEN
        RETURN jsonb_build_object('result_kind', 'claim_ended');
    END IF;
    IF _root.status NOT IN ('funded', 'rewarding', 'exhausted') THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_funded');
    END IF;
    IF lower(trim(_root.owner_wallet)) = _wallet THEN
        RETURN jsonb_build_object('result_kind', 'creator_not_eligible');
    END IF;
    IF _root.status = 'exhausted' OR _root.rewarded_participant_count >= _root.max_rewarded_participants THEN
        RETURN jsonb_build_object('result_kind', 'no_reward_capacity');
    END IF;

    -- (5) Reservation insert. The settlement-scoped unique index is
    -- defense-in-depth behind the pre-insert lookup: a concurrent winner's
    -- commit lands here as a replay instead of a second entitlement.
    _next := _root.rewarded_participant_count + 1;
    _next_status := CASE WHEN _next >= _root.max_rewarded_participants THEN 'exhausted' ELSE 'rewarding' END;
    INSERT INTO public.reward_receipts(
      campaign_id, settlement_id, poll_id, participant_wallet, amount_luna, status
    ) VALUES (
      NULL, _root.id, NULL, _wallet, _root.reward_per_participant_luna, 'reserved'
    )
    ON CONFLICT (settlement_id, (lower(trim(participant_wallet)))) DO NOTHING
    RETURNING id INTO _receipt_id;
    IF _receipt_id IS NULL THEN
        SELECT r.id, r.amount_luna, r.status INTO _existing FROM public.reward_receipts r
        WHERE r.settlement_id = _root.id AND lower(trim(r.participant_wallet)) = _wallet;
        UPDATE public.campaign_claim_challenges SET consumed_at = _now
        WHERE id = _challenge.id AND consumed_at IS NULL;
        RETURN jsonb_build_object('result_kind', 'replay', 'receipt_id', _existing.id,
          'campaign_id', _campaign.id, 'settlement_id', _root.id,
          'participant_wallet', _wallet, 'amount_luna', _existing.amount_luna, 'status', _existing.status);
    END IF;

    -- (6) Counter increment, lifecycle transition, exactly-once first mark.
    UPDATE public.reward_settlements
    SET rewarded_participant_count = _next,
        status = _next_status,
        first_reservation_at = COALESCE(first_reservation_at, _now),
        updated_at = _now
    WHERE id = _root.id;

    -- (7) Consume the exact presented challenge in the same commit.
    UPDATE public.campaign_claim_challenges SET consumed_at = _now WHERE id = _challenge.id;

    RETURN jsonb_build_object('result_kind', 'reserved', 'receipt_id', _receipt_id,
      'campaign_id', _campaign.id, 'settlement_id', _root.id,
      'participant_wallet', _wallet, 'amount_luna', _root.reward_per_participant_luna,
      'status', 'reserved', 'campaign_status', _next_status,
      'rewarded_participant_count', _next,
      'rewards_remaining', _root.max_rewarded_participants - _next);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_campaign_reward_atomic(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_campaign_reward_atomic(uuid, text, uuid) TO service_role;
