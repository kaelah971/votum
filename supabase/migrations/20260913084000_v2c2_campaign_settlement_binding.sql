-- V2C.2C Campaign source binding and service-role foundation boundary.

ALTER TABLE public.settlement_source_bindings
  ADD COLUMN participation_campaign_id uuid UNIQUE
      REFERENCES public.participation_campaigns(id);

ALTER TABLE public.settlement_source_bindings
  ALTER COLUMN reward_campaign_id DROP NOT NULL;

ALTER TABLE public.settlement_source_bindings
  DROP CONSTRAINT settlement_source_type_poll_only;

ALTER TABLE public.settlement_source_bindings
  ADD CONSTRAINT settlement_source_type CHECK (
      source_type IN ('poll_reward_campaign', 'participation_campaign')
  );

ALTER TABLE public.settlement_source_bindings
  ADD CONSTRAINT settlement_source_exactly_one CHECK (
      (source_type = 'poll_reward_campaign'
       AND reward_campaign_id IS NOT NULL
       AND participation_campaign_id IS NULL)
      OR
      (source_type = 'participation_campaign'
       AND reward_campaign_id IS NULL
       AND participation_campaign_id IS NOT NULL)
  );

CREATE INDEX idx_settlement_source_bindings_participation_campaign
    ON public.settlement_source_bindings (participation_campaign_id);

-- The existing Poll validator remains authoritative for Poll bindings, but it
-- must not run against the new Campaign branch.
DROP TRIGGER settlement_source_bindings_poll_consistency
  ON public.settlement_source_bindings;

CREATE TRIGGER settlement_source_bindings_poll_consistency
  AFTER INSERT OR UPDATE ON public.settlement_source_bindings
  FOR EACH ROW
  WHEN (NEW.source_type = 'poll_reward_campaign')
  EXECUTE FUNCTION public.validate_poll_settlement_binding();

CREATE OR REPLACE FUNCTION public.validate_participation_campaign_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _root_owner text;
BEGIN
    SELECT s.owner_wallet
    INTO _root_owner
    FROM public.reward_settlements s
    WHERE s.id = NEW.settlement_id;

    IF NOT FOUND OR lower(trim(_root_owner)) <> lower(trim(NEW.owner_wallet)) THEN
        RAISE EXCEPTION 'participation Campaign owner/root mismatch'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.settlement_id IS DISTINCT FROM NEW.settlement_id THEN
        RAISE EXCEPTION 'participation Campaign settlement is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF TG_OP = 'INSERT' OR OLD.settlement_id IS DISTINCT FROM NEW.settlement_id THEN
        IF EXISTS (
            SELECT 1
            FROM public.settlement_source_bindings b
            WHERE b.settlement_id = NEW.settlement_id
        ) THEN
            RAISE EXCEPTION 'settlement already has a source binding'
                USING ERRCODE = 'unique_violation';
        END IF;
        IF EXISTS (
            SELECT 1
            FROM public.reward_campaigns c
            WHERE c.settlement_id = NEW.settlement_id
        ) THEN
            RAISE EXCEPTION 'settlement already belongs to a Poll reward campaign'
                USING ERRCODE = 'unique_violation';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.owner_wallet IS DISTINCT FROM NEW.owner_wallet THEN
        RAISE EXCEPTION 'participation Campaign owner is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.configuration_locked_at IS NOT NULL THEN
        IF OLD.campaign_type IS DISTINCT FROM NEW.campaign_type
           OR OLD.visibility IS DISTINCT FROM NEW.visibility
           OR OLD.title IS DISTINCT FROM NEW.title
           OR OLD.description IS DISTINCT FROM NEW.description
           OR OLD.configuration_version IS DISTINCT FROM NEW.configuration_version
           OR OLD.starts_at IS DISTINCT FROM NEW.starts_at
           OR OLD.ends_at IS DISTINCT FROM NEW.ends_at
           OR OLD.published_configuration_version IS DISTINCT FROM NEW.published_configuration_version THEN
            RAISE EXCEPTION 'published Campaign configuration is immutable'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    IF NEW.status = 'published' THEN
        IF NEW.campaign_type <> 'public_giveaway'
           OR NEW.published_configuration_version IS DISTINCT FROM NEW.configuration_version
           OR NEW.configuration_locked_at IS NULL
           OR NEW.published_at IS NULL THEN
            RAISE EXCEPTION 'Campaign is not publishable in this foundation slice'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' AND NEW.status = 'draft' THEN
        RAISE EXCEPTION 'Campaign lifecycle cannot return to draft'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_participation_campaign_row() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_participation_campaign_row() TO service_role;

CREATE TRIGGER participation_campaign_row_guard
  BEFORE INSERT OR UPDATE ON public.participation_campaigns
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_participation_campaign_row();

CREATE OR REPLACE FUNCTION public.validate_participation_campaign_binding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign record;
    _root_owner text;
BEGIN
    IF NEW.source_type <> 'participation_campaign'
       OR NEW.reward_campaign_id IS NOT NULL
       OR NEW.participation_campaign_id IS NULL THEN
        RAISE EXCEPTION 'participation Campaign binding branch mismatch'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' AND (
        OLD.settlement_id IS DISTINCT FROM NEW.settlement_id
        OR OLD.source_type IS DISTINCT FROM NEW.source_type
        OR OLD.reward_campaign_id IS DISTINCT FROM NEW.reward_campaign_id
        OR OLD.participation_campaign_id IS DISTINCT FROM NEW.participation_campaign_id
    ) THEN
        RAISE EXCEPTION 'settlement source binding is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT c.id, c.settlement_id, c.owner_wallet
    INTO _campaign
    FROM public.participation_campaigns c
    WHERE c.id = NEW.participation_campaign_id;
    IF NOT FOUND OR _campaign.settlement_id IS DISTINCT FROM NEW.settlement_id THEN
        RAISE EXCEPTION 'participation Campaign/settlement mismatch'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT s.owner_wallet
    INTO _root_owner
    FROM public.reward_settlements s
    WHERE s.id = NEW.settlement_id;
    IF NOT FOUND OR lower(trim(_root_owner)) <> lower(trim(_campaign.owner_wallet)) THEN
        RAISE EXCEPTION 'participation Campaign binding owner/root mismatch'
            USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.reward_campaigns c
        WHERE c.settlement_id = NEW.settlement_id
    ) THEN
        RAISE EXCEPTION 'settlement already belongs to a Poll reward campaign'
            USING ERRCODE = 'unique_violation';
    END IF;

    IF EXISTS (SELECT 1 FROM public.reward_funding_transactions f WHERE f.settlement_id = NEW.settlement_id)
       OR EXISTS (SELECT 1 FROM public.reward_receipts r WHERE r.settlement_id = NEW.settlement_id)
       OR EXISTS (SELECT 1 FROM public.reward_refunds r WHERE r.settlement_id = NEW.settlement_id)
       OR EXISTS (SELECT 1 FROM public.reward_campaign_vaults v WHERE v.settlement_id = NEW.settlement_id) THEN
        RAISE EXCEPTION 'settlement source binding is frozen by financial activity'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_participation_campaign_binding() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_participation_campaign_binding() TO service_role;

CREATE TRIGGER settlement_source_bindings_campaign_consistency
  AFTER INSERT OR UPDATE ON public.settlement_source_bindings
  FOR EACH ROW
  WHEN (NEW.source_type = 'participation_campaign')
  EXECUTE FUNCTION public.validate_participation_campaign_binding();

CREATE OR REPLACE FUNCTION public.reject_participation_campaign_binding_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION 'participation Campaign source binding is immutable'
        USING ERRCODE = 'restrict_violation';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reject_participation_campaign_binding_change() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_participation_campaign_binding_change() TO service_role;

CREATE TRIGGER settlement_source_bindings_campaign_immutable
  BEFORE UPDATE OR DELETE ON public.settlement_source_bindings
  FOR EACH ROW
  WHEN (OLD.source_type = 'participation_campaign')
  EXECUTE FUNCTION public.reject_participation_campaign_binding_change();

CREATE OR REPLACE FUNCTION public.validate_participation_campaign_root_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.owner_wallet IS DISTINCT FROM OLD.owner_wallet
       AND EXISTS (
           SELECT 1
           FROM public.participation_campaigns c
           WHERE c.settlement_id = OLD.id
       ) THEN
        RAISE EXCEPTION 'participation Campaign owner/root mismatch'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_participation_campaign_root_update() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_participation_campaign_root_update() TO service_role;

CREATE TRIGGER participation_campaign_root_guard
  BEFORE UPDATE OF owner_wallet ON public.reward_settlements
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_participation_campaign_root_update();

CREATE OR REPLACE FUNCTION public.validate_participation_campaign_source_exists()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.settlement_source_bindings b
        WHERE b.source_type = 'participation_campaign'
          AND b.settlement_id = NEW.settlement_id
          AND b.participation_campaign_id = NEW.id
          AND b.reward_campaign_id IS NULL
    ) THEN
        RAISE EXCEPTION 'participation Campaign source binding is required'
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_participation_campaign_source_exists() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_participation_campaign_source_exists() TO service_role;

CREATE CONSTRAINT TRIGGER participation_campaign_source_required
  AFTER INSERT OR UPDATE ON public.participation_campaigns
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_participation_campaign_source_exists();

CREATE OR REPLACE FUNCTION public.create_participation_campaign_atomic(
    _owner_wallet text,
    _campaign_type text,
    _visibility text,
    _title text,
    _description text,
    _starts_at timestamptz,
    _ends_at timestamptz,
    _funding_mode text,
    _funding_wallet text,
    _reward_per_participant_luna bigint,
    _max_rewarded_participants integer,
    _fee_reserve_luna bigint
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _settlement_id uuid := gen_random_uuid();
    _campaign_id uuid := gen_random_uuid();
    _principal bigint;
BEGIN
    IF _owner_wallet <> lower(trim(_owner_wallet))
       OR _owner_wallet !~ '^[0-9a-f]{40}$'
       OR _funding_wallet <> lower(trim(_funding_wallet))
       OR _funding_wallet !~ '^[0-9a-f]{40}$' THEN
        RAISE EXCEPTION 'Campaign owner and funder must be canonical wallets'
            USING ERRCODE = 'check_violation';
    END IF;

    _principal := _reward_per_participant_luna * _max_rewarded_participants;

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
        status
    ) VALUES (
        _settlement_id,
        _owner_wallet,
        _funding_wallet,
        _owner_wallet,
        _funding_mode,
        'NIM',
        _reward_per_participant_luna,
        _max_rewarded_participants,
        _principal,
        _fee_reserve_luna,
        _principal + _fee_reserve_luna,
        'configured'
    );

    INSERT INTO public.participation_campaigns (
        id,
        settlement_id,
        owner_wallet,
        campaign_type,
        visibility,
        title,
        description,
        starts_at,
        ends_at
    ) VALUES (
        _campaign_id,
        _settlement_id,
        _owner_wallet,
        _campaign_type,
        _visibility,
        _title,
        _description,
        _starts_at,
        _ends_at
    );

    INSERT INTO public.settlement_source_bindings (
        settlement_id,
        source_type,
        participation_campaign_id
    ) VALUES (
        _settlement_id,
        'participation_campaign',
        _campaign_id
    );

    RETURN json_build_object(
        'campaign_id', _campaign_id,
        'settlement_id', _settlement_id,
        'status', 'draft'
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_participation_campaign_draft_atomic(
    _campaign_id uuid,
    _title text,
    _description text,
    _campaign_type text,
    _visibility text,
    _starts_at timestamptz,
    _ends_at timestamptz,
    _configuration_version integer,
    _funding_mode text,
    _funding_wallet text,
    _reward_per_participant_luna bigint,
    _max_rewarded_participants integer,
    _fee_reserve_luna bigint
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign public.participation_campaigns%ROWTYPE;
    _root_status text;
    _first_reservation_at timestamptz;
BEGIN
    SELECT * INTO _campaign
    FROM public.participation_campaigns
    WHERE id = _campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'participation Campaign not found'
            USING ERRCODE = 'no_data_found';
    END IF;

    SELECT s.status, s.first_reservation_at
    INTO _root_status, _first_reservation_at
    FROM public.reward_settlements s
    WHERE s.id = _campaign.settlement_id
    FOR UPDATE;
    IF NOT FOUND OR _root_status <> 'configured' OR _first_reservation_at IS NOT NULL THEN
        RAISE EXCEPTION 'Campaign configuration is financially frozen'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF _campaign.status <> 'draft' OR _campaign.configuration_locked_at IS NOT NULL THEN
        RAISE EXCEPTION 'only draft Campaigns can be updated'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF _configuration_version <= _campaign.configuration_version THEN
        RAISE EXCEPTION 'configuration version must advance'
            USING ERRCODE = 'check_violation';
    END IF;

    UPDATE public.participation_campaigns
    SET title = _title,
        description = _description,
        campaign_type = _campaign_type,
        visibility = _visibility,
        starts_at = _starts_at,
        ends_at = _ends_at,
        configuration_version = _configuration_version,
        updated_at = now()
    WHERE id = _campaign_id;

    UPDATE public.reward_settlements
    SET funding_mode = _funding_mode,
        funding_wallet = _funding_wallet,
        refund_recipient_wallet = _campaign.owner_wallet,
        reward_per_participant_luna = _reward_per_participant_luna,
        max_rewarded_participants = _max_rewarded_participants,
        reward_principal_luna = _reward_per_participant_luna * _max_rewarded_participants,
        fee_reserve_luna = _fee_reserve_luna,
        total_budget_luna = (_reward_per_participant_luna * _max_rewarded_participants) + _fee_reserve_luna,
        updated_at = now()
    WHERE id = _campaign.settlement_id;

    RETURN json_build_object(
        'campaign_id', _campaign_id,
        'settlement_id', _campaign.settlement_id,
        'status', 'draft',
        'configuration_version', _configuration_version
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_participation_campaign_atomic(
    _campaign_id uuid,
    _published_configuration_version integer
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign public.participation_campaigns%ROWTYPE;
    _root_status text;
    _first_reservation_at timestamptz;
BEGIN
    SELECT * INTO _campaign
    FROM public.participation_campaigns
    WHERE id = _campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'participation Campaign not found'
            USING ERRCODE = 'no_data_found';
    END IF;

    SELECT s.status, s.first_reservation_at
    INTO _root_status, _first_reservation_at
    FROM public.reward_settlements s
    WHERE s.id = _campaign.settlement_id
    FOR UPDATE;
    IF NOT FOUND OR _root_status <> 'configured' OR _first_reservation_at IS NOT NULL THEN
        RAISE EXCEPTION 'Campaign root is not publish-ready'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF _campaign.status <> 'draft'
       OR _campaign.campaign_type <> 'public_giveaway'
       OR _published_configuration_version <> _campaign.configuration_version THEN
        RAISE EXCEPTION 'Campaign configuration is not publishable in this slice'
            USING ERRCODE = 'check_violation';
    END IF;

    UPDATE public.participation_campaigns
    SET status = 'published',
        published_configuration_version = _published_configuration_version,
        configuration_locked_at = now(),
        published_at = now(),
        updated_at = now()
    WHERE id = _campaign_id;

    RETURN json_build_object(
        'campaign_id', _campaign_id,
        'settlement_id', _campaign.settlement_id,
        'status', 'published',
        'configuration_version', _published_configuration_version
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_participation_campaign_atomic(text, text, text, text, text, timestamptz, timestamptz, text, text, bigint, integer, bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_participation_campaign_draft_atomic(uuid, text, text, text, text, timestamptz, timestamptz, integer, text, text, bigint, integer, bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.publish_participation_campaign_atomic(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_participation_campaign_atomic(text, text, text, text, text, timestamptz, timestamptz, text, text, bigint, integer, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_participation_campaign_draft_atomic(uuid, text, text, text, text, timestamptz, timestamptz, integer, text, text, bigint, integer, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_participation_campaign_atomic(uuid, integer) TO service_role;
