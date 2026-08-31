-- V2B.2.4A reward-first product alignment.
--
-- Existing polls remain legacy-support polls. New reward-first polls omit the
-- participant-support configuration entirely and use the explicit economic
-- discriminator below. Existing support tables, rows, RPCs, and contracts are
-- preserved.

-- ============================================================================
-- 1. Poll economic discriminator
-- ============================================================================

ALTER TABLE public.polls
  ADD COLUMN IF NOT EXISTS economic_model text NOT NULL DEFAULT 'legacy_support';

ALTER TABLE public.polls
  ADD COLUMN IF NOT EXISTS reward_mode text;

-- Existing rows are intentionally not rewritten economically: they retain all
-- of their support configuration and are classified as legacy.
UPDATE public.polls
   SET economic_model = 'legacy_support',
       reward_mode = NULL
 WHERE economic_model IS NULL OR economic_model = '';

ALTER TABLE public.polls
  ALTER COLUMN economic_model SET DEFAULT 'legacy_support';

-- These four columns remain physically present for legacy data, but must be
-- nullable so reward-first rows can omit participant-payment configuration.
ALTER TABLE public.polls ALTER COLUMN mode DROP NOT NULL;
ALTER TABLE public.polls ALTER COLUMN destination_wallet DROP NOT NULL;
ALTER TABLE public.polls ALTER COLUMN destination_purpose DROP NOT NULL;
ALTER TABLE public.polls ALTER COLUMN min_nim_luna DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'polls_economic_model_values'
       AND conrelid = 'public.polls'::regclass
  ) THEN
    ALTER TABLE public.polls
      ADD CONSTRAINT polls_economic_model_values
        CHECK (economic_model IN ('legacy_support', 'reward_first'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'polls_reward_mode_values'
       AND conrelid = 'public.polls'::regclass
  ) THEN
    ALTER TABLE public.polls
      ADD CONSTRAINT polls_reward_mode_values
        CHECK (
          (economic_model = 'legacy_support' AND reward_mode IS NULL)
          OR (
            economic_model = 'reward_first'
            AND reward_mode IN ('free', 'rewarded')
          )
        );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'polls_legacy_support_fields'
       AND conrelid = 'public.polls'::regclass
  ) THEN
    ALTER TABLE public.polls
      ADD CONSTRAINT polls_legacy_support_fields
        CHECK (
          economic_model = 'reward_first'
          OR (
            mode IN ('creator_support', 'community_support')
            AND length(trim(destination_wallet)) > 0
            AND length(trim(destination_purpose)) > 0
            AND min_nim_luna > 0
          )
        );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'polls_reward_first_support_absent'
       AND conrelid = 'public.polls'::regclass
  ) THEN
    ALTER TABLE public.polls
      ADD CONSTRAINT polls_reward_first_support_absent
        CHECK (
          economic_model = 'legacy_support'
          OR (
            mode IS NULL
            AND destination_wallet IS NULL
            AND destination_purpose IS NULL
            AND min_nim_luna IS NULL
          )
        );
  END IF;
END;
$$;

-- ============================================================================
-- 2. Reward campaign funding source
-- ============================================================================

ALTER TABLE public.reward_campaigns
  ADD COLUMN IF NOT EXISTS funding_mode text NOT NULL DEFAULT 'creator';

ALTER TABLE public.reward_campaigns
  ADD COLUMN IF NOT EXISTS funding_wallet text;

UPDATE public.reward_campaigns
   SET funding_mode = 'creator',
       funding_wallet = creator_wallet
 WHERE funding_wallet IS NULL OR funding_wallet = '';

ALTER TABLE public.reward_campaigns
  ALTER COLUMN funding_mode SET DEFAULT 'creator';
ALTER TABLE public.reward_campaigns
  ALTER COLUMN funding_wallet SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reward_campaigns_funding_mode'
       AND conrelid = 'public.reward_campaigns'::regclass
  ) THEN
    ALTER TABLE public.reward_campaigns
      ADD CONSTRAINT reward_campaigns_funding_mode
        CHECK (funding_mode IN ('creator', 'community'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reward_campaigns_funding_wallet_not_empty'
       AND conrelid = 'public.reward_campaigns'::regclass
  ) THEN
    ALTER TABLE public.reward_campaigns
      ADD CONSTRAINT reward_campaigns_funding_wallet_not_empty
        CHECK (length(trim(funding_wallet)) > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'reward_campaigns_creator_funding_wallet'
       AND conrelid = 'public.reward_campaigns'::regclass
  ) THEN
    ALTER TABLE public.reward_campaigns
      ADD CONSTRAINT reward_campaigns_creator_funding_wallet
        CHECK (funding_mode <> 'creator' OR lower(funding_wallet) = lower(creator_wallet));
  END IF;
END;
$$;

-- ============================================================================
-- 3. Discriminator-aware atomic publication
-- ============================================================================

-- Remove only the current overload. The replacement below keeps defaults for
-- category/format and the old 12-argument caller shape.
DROP FUNCTION IF EXISTS public.publish_poll_atomic(
    text, text, text, text, text, text, bigint, text, timestamptz,
    text[], uuid, text, text, text
);

CREATE OR REPLACE FUNCTION public.publish_poll_atomic(
    _creator_wallet       text,
    _question             text,
    _description          text,
    _mode                 text,
    _destination_wallet   text,
    _destination_purpose  text,
    _min_nim_luna         bigint,
    _fairness_mode        text,
    _ends_at              timestamptz,
    _options              text[],
    _idempotency_key      uuid,
    _request_fingerprint  text,
    _category             text DEFAULT 'communities',
    _format               text DEFAULT 'decision',
    _economic_model       text DEFAULT 'legacy_support',
    _reward_mode          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    _now        timestamptz := now();
    _lock_key   bigint;
    _hex        text;
    _i          int;
    _ch         text;
    _digit      int;
    _existing   record;
    _poll_id    uuid;
    _opt_label  text;
    _idx        int;
BEGIN
    _hex := replace(_idempotency_key::text, '-', '');
    _lock_key := 0;
    FOR _i IN 1..15 LOOP
        _ch := lower(substr(_hex, _i, 1));
        _digit := CASE _ch
            WHEN '0' THEN 0 WHEN '1' THEN 1 WHEN '2' THEN 2
            WHEN '3' THEN 3 WHEN '4' THEN 4 WHEN '5' THEN 5
            WHEN '6' THEN 6 WHEN '7' THEN 7 WHEN '8' THEN 8
            WHEN '9' THEN 9 WHEN 'a' THEN 10 WHEN 'b' THEN 11
            WHEN 'c' THEN 12 WHEN 'd' THEN 13 WHEN 'e' THEN 14
            WHEN 'f' THEN 15 ELSE 0
        END;
        _lock_key := _lock_key * 16 + _digit;
    END LOOP;
    IF _lock_key = 0 THEN _lock_key := 1; END IF;
    PERFORM pg_advisory_xact_lock(_lock_key);

    SELECT poll_id, request_fingerprint INTO _existing
    FROM public.poll_publication_requests
    WHERE creator_wallet = _creator_wallet
      AND idempotency_key = _idempotency_key;

    IF FOUND THEN
        IF _existing.request_fingerprint = _request_fingerprint THEN
            RETURN jsonb_build_object(
                'id', _existing.poll_id,
                'status', (SELECT status FROM public.polls WHERE id = _existing.poll_id),
                'result_kind', 'replay'
            );
        ELSE
            RETURN jsonb_build_object(
                'id', null,
                'status', null,
                'result_kind', 'conflict'
            );
        END IF;
    END IF;

    IF _economic_model NOT IN ('legacy_support', 'reward_first') THEN
        RAISE EXCEPTION 'Invalid poll economic model' USING ERRCODE = 'check_violation';
    END IF;

    IF _economic_model = 'legacy_support' THEN
        IF _reward_mode IS NOT NULL THEN
            RAISE EXCEPTION 'Legacy support polls cannot have reward mode' USING ERRCODE = 'check_violation';
        END IF;
        IF _mode NOT IN ('creator_support', 'community_support')
           OR _destination_wallet IS NULL
           OR length(trim(_destination_wallet)) = 0
           OR _destination_purpose IS NULL
           OR length(trim(_destination_purpose)) = 0
           OR _min_nim_luna IS NULL
           OR _min_nim_luna <= 0 THEN
            RAISE EXCEPTION 'Legacy support fields are required' USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        IF _reward_mode NOT IN ('free', 'rewarded') THEN
            RAISE EXCEPTION 'Reward-first polls require free or rewarded mode' USING ERRCODE = 'check_violation';
        END IF;
        IF _mode IS NOT NULL
           OR _destination_wallet IS NOT NULL
           OR _destination_purpose IS NOT NULL
           OR _min_nim_luna IS NOT NULL THEN
            RAISE EXCEPTION 'Reward-first polls cannot contain support fields' USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF array_length(_options, 1) < 2 THEN
        RAISE EXCEPTION 'At least 2 options are required' USING ERRCODE = 'check_violation';
    END IF;

    IF array_length(_options, 1) > 6 THEN
        RAISE EXCEPTION 'Maximum 6 options allowed' USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(DISTINCT lower(trim(opt))) FROM unnest(_options) opt)
       <> array_length(_options, 1) THEN
        RAISE EXCEPTION 'Duplicate option labels are not allowed' USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.polls (
        creator_wallet, question, description, mode,
        destination_wallet, destination_purpose, min_nim_luna,
        fairness_mode, status, starts_at, ends_at, is_public, published_at,
        created_at, updated_at, category, format, economic_model, reward_mode
    ) VALUES (
        _creator_wallet, trim(_question),
        CASE WHEN _description IS NOT NULL AND length(trim(_description)) > 0
             THEN trim(_description) ELSE NULL END,
        _mode, _destination_wallet,
        CASE WHEN _destination_purpose IS NOT NULL
             THEN trim(_destination_purpose) ELSE NULL END,
        _min_nim_luna, _fairness_mode, 'live', _now, _ends_at, true, _now,
        _now, _now, _category, _format, _economic_model, _reward_mode
    )
    RETURNING id INTO _poll_id;

    _idx := 0;
    FOREACH _opt_label IN ARRAY _options LOOP
        INSERT INTO public.poll_options (poll_id, label, sort_order)
        VALUES (_poll_id, trim(_opt_label), _idx);
        _idx := _idx + 1;
    END LOOP;

    INSERT INTO public.poll_publication_requests
        (creator_wallet, idempotency_key, poll_id, request_fingerprint)
    VALUES (_creator_wallet, _idempotency_key, _poll_id, _request_fingerprint);

    RETURN jsonb_build_object(
        'id', _poll_id,
        'status', 'live',
        'result_kind', 'created'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.publish_poll_atomic(
    text, text, text, text, text, text, bigint, text, timestamptz,
    text[], uuid, text, text, text, text, text
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.publish_poll_atomic(
    text, text, text, text, text, text, bigint, text, timestamptz,
    text[], uuid, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 4. Designated funding-wallet authorization
-- ============================================================================

ALTER TABLE public.reward_funding_transactions
  ADD COLUMN funder_wallet text;

UPDATE public.reward_funding_transactions
   SET funder_wallet = creator_wallet
 WHERE funder_wallet IS NULL OR funder_wallet = '';

ALTER TABLE public.reward_funding_transactions
  ALTER COLUMN funder_wallet SET NOT NULL;

ALTER TABLE public.reward_funding_transactions
  ADD CONSTRAINT reward_funding_funder_wallet_not_empty
  CHECK (length(trim(funder_wallet)) > 0);

DROP FUNCTION IF EXISTS public.begin_reward_funding_atomic(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.begin_reward_funding_atomic(
    _campaign_id uuid,
    _funder_wallet text,
    _confirmation_horizon_minutes integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign record;
    _poll_public boolean;
    _vault record;
    _active record;
    _intent record;
    _horizon integer;
BEGIN
    _horizon := GREATEST(5, LEAST(COALESCE(_confirmation_horizon_minutes, 60), 1440));

    SELECT c.* INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;

    IF lower(_campaign.funding_wallet) <> lower(_funder_wallet) THEN
        RETURN jsonb_build_object('result_kind', 'forbidden');
    END IF;

    SELECT p.is_public INTO _poll_public
    FROM public.polls p
    WHERE p.id = _campaign.poll_id;

    IF NOT COALESCE(_poll_public, false) THEN
        RETURN jsonb_build_object('result_kind', 'poll_not_public');
    END IF;

    SELECT v.vault_address_hex INTO _vault
    FROM public.reward_campaign_vaults v
    WHERE v.campaign_id = _campaign_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'vault_missing');
    END IF;

    IF _campaign.total_budget_luna > 9007199254740991::bigint THEN
        RETURN jsonb_build_object('result_kind', 'funding_amount_unsafe');
    END IF;

    SELECT f.* INTO _active
    FROM public.reward_funding_transactions f
    WHERE f.campaign_id = _campaign_id
      AND f.status = 'submitted'
      AND lower(f.funder_wallet) = lower(_funder_wallet)
    ORDER BY f.created_at DESC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'result_kind', 'replay',
            'intent_id', _active.id,
            'campaign_id', _active.campaign_id,
            'reference', _active.reference,
            'vault_wallet', _active.vault_wallet,
            'reward_principal_luna', _active.reward_principal_luna::text,
            'fee_reserve_luna', _active.fee_reserve_luna::text,
            'amount_luna', _active.amount_luna::text,
            'submitted_transaction_hash', _active.submitted_transaction_hash,
            'confirmation_deadline', _active.confirmation_deadline,
            'created_at', _active.created_at
        );
    END IF;

    IF _campaign.status <> 'configured' THEN
        RETURN jsonb_build_object(
            'result_kind', 'campaign_state_conflict',
            'state', _campaign.status
        );
    END IF;

    INSERT INTO public.reward_funding_transactions (
        campaign_id,
        creator_wallet,
        funder_wallet,
        reference,
        amount_luna,
        status,
        confirmation_deadline,
        vault_wallet,
        reward_principal_luna,
        fee_reserve_luna
    ) VALUES (
        _campaign_id,
        _campaign.creator_wallet,
        _funder_wallet,
        'votum:fund:' || replace(gen_random_uuid()::text, '-', ''),
        _campaign.total_budget_luna,
        'submitted',
        now() + (_horizon || ' minutes')::interval,
        _vault.vault_address_hex,
        _campaign.reward_principal_luna,
        _campaign.fee_reserve_luna
    )
    RETURNING * INTO _intent;

    UPDATE public.reward_campaigns
    SET status = 'funding_pending', updated_at = now()
    WHERE id = _campaign_id;

    RETURN jsonb_build_object(
        'result_kind', 'created',
        'intent_id', _intent.id,
        'campaign_id', _intent.campaign_id,
        'reference', _intent.reference,
        'vault_wallet', _intent.vault_wallet,
        'reward_principal_luna', _intent.reward_principal_luna::text,
        'fee_reserve_luna', _intent.fee_reserve_luna::text,
        'amount_luna', _intent.amount_luna::text,
        'submitted_transaction_hash', _intent.submitted_transaction_hash,
        'confirmation_deadline', _intent.confirmation_deadline,
        'created_at', _intent.created_at
    );
END;
$$;

DROP FUNCTION IF EXISTS public.bind_reward_funding_transaction_atomic(uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION public.bind_reward_funding_transaction_atomic(
    _campaign_id uuid,
    _intent_id uuid,
    _funder_wallet text,
    _transaction_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign record;
    _intent record;
    _existing record;
    _hash_lock bigint;
BEGIN
    SELECT c.* INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;

    IF lower(_campaign.funding_wallet) <> lower(_funder_wallet) THEN
        RETURN jsonb_build_object('result_kind', 'forbidden');
    END IF;

    IF _campaign.status <> 'funding_pending' THEN
        RETURN jsonb_build_object(
            'result_kind', 'campaign_state_conflict',
            'state', _campaign.status
        );
    END IF;

    IF _transaction_hash IS NULL OR _transaction_hash !~ '^[0-9a-f]{64}$' THEN
        RETURN jsonb_build_object('result_kind', 'invalid_hash');
    END IF;

    _hash_lock := ('x' || substr(_transaction_hash, 1, 15))::bit(64)::bigint;
    IF _hash_lock = 0 THEN _hash_lock := 1; END IF;
    PERFORM pg_advisory_xact_lock(_hash_lock);

    SELECT f.* INTO _intent
    FROM public.reward_funding_transactions f
    WHERE f.id = _intent_id
      AND f.campaign_id = _campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'intent_not_found');
    END IF;

    IF lower(_intent.funder_wallet) <> lower(_funder_wallet) THEN
        RETURN jsonb_build_object('result_kind', 'forbidden');
    END IF;

    IF _intent.submitted_transaction_hash = _transaction_hash THEN
        RETURN jsonb_build_object(
            'result_kind', 'bound_replay',
            'intent_id', _intent.id,
            'campaign_id', _intent.campaign_id,
            'reference', _intent.reference,
            'submitted_transaction_hash', _intent.submitted_transaction_hash
        );
    END IF;

    IF _intent.submitted_transaction_hash IS NOT NULL THEN
        RETURN jsonb_build_object('result_kind', 'intent_already_bound');
    END IF;

    IF _intent.status <> 'submitted' THEN
        RETURN jsonb_build_object('result_kind', 'intent_state_conflict', 'state', _intent.status);
    END IF;

    SELECT f.id INTO _existing
    FROM public.reward_funding_transactions f
    WHERE f.id <> _intent_id
      AND (
        f.submitted_transaction_hash = _transaction_hash
        OR f.confirmed_transaction_hash = _transaction_hash
      )
    LIMIT 1;

    IF FOUND THEN
        RETURN jsonb_build_object('result_kind', 'transaction_already_reserved');
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.nim_support_intents s
        WHERE s.submitted_transaction_hash = _transaction_hash
    ) OR EXISTS (
        SELECT 1 FROM public.nim_contributions c
        WHERE c.transaction_hash = _transaction_hash
    ) OR EXISTS (
        SELECT 1 FROM public.reward_payout_attempts p
        WHERE p.transaction_hash = _transaction_hash
    ) OR EXISTS (
        SELECT 1 FROM public.reward_refunds r
        WHERE r.transaction_hash = _transaction_hash
    ) THEN
        RETURN jsonb_build_object('result_kind', 'transaction_already_reserved');
    END IF;

    UPDATE public.reward_funding_transactions
    SET submitted_transaction_hash = _transaction_hash,
        submitted_at = now(),
        updated_at = now()
    WHERE id = _intent_id;

    RETURN jsonb_build_object(
        'result_kind', 'bound',
        'intent_id', _intent_id,
        'campaign_id', _campaign_id,
        'reference', _intent.reference,
        'submitted_transaction_hash', _transaction_hash
    );
EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object('result_kind', 'transaction_already_reserved');
END;
$$;

GRANT EXECUTE ON FUNCTION public.begin_reward_funding_atomic(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_reward_funding_transaction_atomic(uuid, uuid, text, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.begin_reward_funding_atomic(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bind_reward_funding_transaction_atomic(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
