-- V2C.2A Poll settlement staging and deterministic root backfill.
--
-- This is a snapshot/backfill migration only. reward_campaigns remains the live
-- financial authority. Historical source columns are never rewritten and no
-- financial child or vault table is touched here.

ALTER TABLE public.reward_campaigns
  ADD COLUMN settlement_id uuid
  REFERENCES public.reward_settlements(id);

CREATE TABLE public.settlement_source_bindings (
    settlement_id      uuid PRIMARY KEY
        REFERENCES public.reward_settlements(id),
    source_type        text NOT NULL,
    reward_campaign_id uuid NOT NULL UNIQUE
        REFERENCES public.reward_campaigns(id),
    created_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT settlement_source_type_poll_only CHECK (
        source_type = 'poll_reward_campaign'
    )
);

CREATE INDEX idx_settlement_source_bindings_campaign
    ON public.settlement_source_bindings (reward_campaign_id);

ALTER TABLE public.settlement_source_bindings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.settlement_source_bindings FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.settlement_source_bindings TO service_role;

-- Reject historical rows that cannot produce the canonical root shape without
-- guessing or rewriting source identity. Valid alternate Nimiq representations
-- are reported by the application preflight; this SQL boundary accepts only the
-- already-canonical representation that PostgreSQL can validate itself.
DO $$
DECLARE
    _bad record;
BEGIN
    SELECT c.id, 'reward_campaigns.creator_wallet' AS invariant
    INTO _bad
    FROM public.reward_campaigns c
    WHERE c.creator_wallet <> lower(trim(c.creator_wallet))
       OR c.creator_wallet !~ '^[0-9a-f]{40}$'
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'v2c2a backfill blocked: row_id=% invariant=%',
            _bad.id, _bad.invariant
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT c.id, 'reward_campaigns.funding_wallet' AS invariant
    INTO _bad
    FROM public.reward_campaigns c
    WHERE c.funding_wallet <> lower(trim(c.funding_wallet))
       OR c.funding_wallet !~ '^[0-9a-f]{40}$'
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'v2c2a backfill blocked: row_id=% invariant=%',
            _bad.id, _bad.invariant
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT p.id, 'polls.creator_wallet' AS invariant
    INTO _bad
    FROM public.polls p
    WHERE p.creator_wallet <> lower(trim(p.creator_wallet))
       OR p.creator_wallet !~ '^[0-9a-f]{40}$'
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'v2c2a backfill blocked: row_id=% invariant=%',
            _bad.id, _bad.invariant
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT c.id, 'campaign_poll_owner_mismatch' AS invariant
    INTO _bad
    FROM public.reward_campaigns c
    JOIN public.polls p ON p.id = c.poll_id
    WHERE lower(trim(c.creator_wallet)) <> lower(trim(p.creator_wallet))
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'v2c2a backfill blocked: row_id=% invariant=%',
            _bad.id, _bad.invariant
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT c.id, 'creator_funding_policy_mismatch' AS invariant
    INTO _bad
    FROM public.reward_campaigns c
    WHERE c.funding_mode = 'creator'
      AND lower(trim(c.funding_wallet)) <> lower(trim(c.creator_wallet))
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'v2c2a backfill blocked: row_id=% invariant=%',
            _bad.id, _bad.invariant
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$;

-- Preserve the current campaign UUID as the settlement UUID. All values are
-- copied from reward_campaigns, which remains authoritative in this phase.
INSERT INTO public.reward_settlements (
    id,
    owner_wallet,
    funding_wallet,
    refund_recipient_wallet,
    funding_mode,
    asset,
    reward_per_participant_luna,
    max_rewarded_participants,
    reward_principal_luna,
    fee_reserve_luna,
    total_budget_luna,
    status,
    funded_amount_luna,
    refundable_excess_luna,
    rewarded_participant_count,
    paid_amount_luna,
    fee_spent_luna,
    refundable_amount_luna,
    first_reservation_at,
    payout_lock_attempt_id,
    payout_lock_expires_at,
    payout_lock_token,
    created_at,
    funded_at,
    closed_at,
    refunded_at,
    updated_at
)
SELECT
    c.id,
    c.creator_wallet,
    c.funding_wallet,
    c.creator_wallet,
    c.funding_mode,
    c.asset,
    c.reward_per_participant_luna,
    c.max_rewarded_participants,
    c.reward_principal_luna,
    c.fee_reserve_luna,
    c.total_budget_luna,
    c.status,
    c.funded_amount_luna,
    c.refundable_excess_luna,
    c.rewarded_participant_count,
    c.paid_amount_luna,
    c.fee_spent_luna,
    c.refundable_amount_luna,
    c.first_reservation_at,
    c.payout_lock_attempt_id,
    c.payout_lock_expires_at,
    c.payout_lock_token,
    c.created_at,
    c.funded_at,
    c.closed_at,
    c.refunded_at,
    c.updated_at
FROM public.reward_campaigns c;

UPDATE public.reward_campaigns c
SET settlement_id = c.id;

-- The binding trigger validates root/source identity and owner consistency for
-- all staging writes made before V2C.2E.
CREATE OR REPLACE FUNCTION public.validate_poll_settlement_binding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign record;
    _poll record;
    _root record;
BEGIN
    IF NEW.source_type <> 'poll_reward_campaign' THEN
        RAISE EXCEPTION 'v2c2a binding source type is Poll-only'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT c.id, c.poll_id, c.settlement_id, c.creator_wallet
    INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = NEW.reward_campaign_id;
    IF NOT FOUND OR _campaign.settlement_id IS NULL
       OR _campaign.settlement_id <> NEW.settlement_id THEN
        RAISE EXCEPTION 'v2c2a binding campaign/settlement mismatch'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT p.id, p.creator_wallet
    INTO _poll
    FROM public.polls p
    WHERE p.id = _campaign.poll_id;
    IF NOT FOUND OR lower(trim(_poll.creator_wallet))
       <> lower(trim(_campaign.creator_wallet)) THEN
        RAISE EXCEPTION 'v2c2a binding Poll owner mismatch'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT s.id, s.owner_wallet
    INTO _root
    FROM public.reward_settlements s
    WHERE s.id = NEW.settlement_id;
    IF NOT FOUND OR lower(trim(_root.owner_wallet))
       <> lower(trim(_campaign.creator_wallet)) THEN
        RAISE EXCEPTION 'v2c2a binding root owner mismatch'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_poll_settlement_binding() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_poll_settlement_binding() TO service_role;

CREATE CONSTRAINT TRIGGER settlement_source_bindings_poll_consistency
AFTER INSERT OR UPDATE ON public.settlement_source_bindings
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION public.validate_poll_settlement_binding();

INSERT INTO public.settlement_source_bindings (
    settlement_id,
    source_type,
    reward_campaign_id
)
SELECT
    c.settlement_id,
    'poll_reward_campaign',
    c.id
FROM public.reward_campaigns c;

-- Make the staging relationship complete before this migration finishes.
DO $$
DECLARE
    _campaign_count bigint;
    _root_count bigint;
    _binding_count bigint;
BEGIN
    SELECT COUNT(*) INTO _campaign_count FROM public.reward_campaigns;
    SELECT COUNT(*) INTO _root_count FROM public.reward_settlements;
    SELECT COUNT(*) INTO _binding_count FROM public.settlement_source_bindings;

    IF _campaign_count <> _root_count OR _campaign_count <> _binding_count THEN
        RAISE EXCEPTION
            'v2c2a backfill coverage mismatch: campaigns=% roots=% bindings=%',
            _campaign_count, _root_count, _binding_count
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$;
