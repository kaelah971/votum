-- V2C.3D Phase 1 Campaign-source compatibility plus shared funding contract
-- cutover.
--
-- The spec default (reuse reward_receipts, no second table) is literally
-- impossible against the shipped Poll-shaped NOT NULL FKs: a standalone
-- Campaign row must never fabricate a reward_campaigns row or a polls row.
-- This migration keeps one ledger and adds a Campaign branch to it:
--
--   Poll rows:     campaign_id IS NOT NULL (plus poll_id IS NOT NULL on receipts)
--   Campaign rows: campaign_id IS NULL (plus poll_id IS NULL on receipts)
--   All rows:      settlement_id IS NOT NULL and remains the authority.
--
-- No participation_campaign_id column is added to any financial table.
-- Product ownership resolves through the funding/receipt row to the
-- settlement to the source binding, never through a duplicated product FK.
--
-- The three shared funding RPCs keep their names and argument TYPE
-- signatures under the canonical _settlement_id first argument, with generic
-- settlement-to-binding source resolution for the Poll branch (A) and the
-- Campaign branch (B). No legacy overload, compatibility wrapper, or
-- begin/bind/confirm_campaign_funding_atomic fork survives. The engine emits
-- source-neutral errors only; Poll and Campaign wording is translated at the
-- adapter and service boundaries, never inside the engine.

-- ============================================================================
-- Phase 1a: preflight. Every existing row must already satisfy the Poll
-- branch shape; otherwise this migration aborts without changing anything.
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.reward_funding_transactions
        WHERE campaign_id IS NULL OR settlement_id IS NULL
    ) THEN
        RAISE EXCEPTION 'v2c3d source migration blocked: reward_funding_transactions has non-Poll rows'
            USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.reward_receipts
        WHERE campaign_id IS NULL OR poll_id IS NULL OR settlement_id IS NULL
    ) THEN
        RAISE EXCEPTION 'v2c3d source migration blocked: reward_receipts has non-Poll rows'
            USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.reward_refunds
        WHERE campaign_id IS NULL OR settlement_id IS NULL
    ) THEN
        RAISE EXCEPTION 'v2c3d source migration blocked: reward_refunds has non-Poll rows'
            USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
        SELECT settlement_id, lower(trim(participant_wallet))
        FROM public.reward_receipts
        GROUP BY settlement_id, lower(trim(participant_wallet))
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'v2c3d source migration blocked: duplicate settlement-scoped receipt identity'
            USING ERRCODE = 'unique_violation';
    END IF;
END;
$$;

-- ============================================================================
-- Phase 1b: nullable compatibility columns plus branch CHECK constraints.
-- ============================================================================

ALTER TABLE public.reward_funding_transactions
  ALTER COLUMN campaign_id DROP NOT NULL;

ALTER TABLE public.reward_receipts
  ALTER COLUMN campaign_id DROP NOT NULL;

ALTER TABLE public.reward_receipts
  ALTER COLUMN poll_id DROP NOT NULL;

ALTER TABLE public.reward_refunds
  ALTER COLUMN campaign_id DROP NOT NULL;

ALTER TABLE public.reward_funding_transactions
  ADD CONSTRAINT reward_funding_source_branch CHECK (
      (campaign_id IS NOT NULL AND settlement_id IS NOT NULL)
      OR (campaign_id IS NULL AND settlement_id IS NOT NULL)
  );

ALTER TABLE public.reward_receipts
  ADD CONSTRAINT reward_receipts_source_branch CHECK (
      (campaign_id IS NOT NULL AND poll_id IS NOT NULL AND settlement_id IS NOT NULL)
      OR (campaign_id IS NULL AND poll_id IS NULL AND settlement_id IS NOT NULL)
  );

ALTER TABLE public.reward_refunds
  ADD CONSTRAINT reward_refunds_source_branch CHECK (
      (campaign_id IS NOT NULL AND settlement_id IS NOT NULL)
      OR (campaign_id IS NULL AND settlement_id IS NOT NULL)
  );

-- Settlement-scoped receipt uniqueness: at most one entitlement per
-- (settlement, canonical wallet) across both branches. NULL campaign_id
-- rows never conflict with each other except through this index.
CREATE UNIQUE INDEX idx_reward_receipts_settlement_wallet
    ON public.reward_receipts (settlement_id, (lower(trim(participant_wallet))));

-- ============================================================================
-- Phase 1c: shared funding RPC contract cutover to _settlement_id.
-- ============================================================================

DROP FUNCTION IF EXISTS public.begin_reward_funding_atomic(uuid, text, integer);
CREATE FUNCTION public.begin_reward_funding_atomic(
    _settlement_id uuid,
    _funder_wallet text,
    _confirmation_horizon_minutes integer DEFAULT 60
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    _root record;
    _campaign record;
    _pcampaign_id uuid;
    _branch text;
    _vault record;
    _active record;
    _intent record;
    _horizon integer := GREATEST(5, LEAST(COALESCE(_confirmation_horizon_minutes, 60), 1440));
BEGIN
    SELECT * INTO _root FROM public.reward_settlements WHERE id = _settlement_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind', 'settlement_not_found'); END IF;
    SELECT c.* INTO _campaign FROM public.reward_campaigns c
    JOIN public.settlement_source_bindings b ON b.reward_campaign_id = c.id
      AND b.source_type = 'poll_reward_campaign' AND b.settlement_id = _root.id;
    IF FOUND THEN
        _branch := 'poll';
    ELSE
        SELECT p.id INTO _pcampaign_id FROM public.participation_campaigns p
        JOIN public.settlement_source_bindings b ON b.participation_campaign_id = p.id
          AND b.source_type = 'participation_campaign' AND b.settlement_id = _root.id;
        IF NOT FOUND THEN RETURN jsonb_build_object('result_kind', 'source_not_supported'); END IF;
        _branch := 'campaign';
    END IF;
    IF lower(_root.funding_wallet) <> lower(trim(_funder_wallet)) THEN RETURN jsonb_build_object('result_kind', 'funding_not_allowed'); END IF;
    SELECT v.vault_address_hex INTO _vault FROM public.reward_campaign_vaults v WHERE v.settlement_id = _root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind', 'vault_missing'); END IF;
    IF _root.total_budget_luna > 9007199254740991::bigint THEN RETURN jsonb_build_object('result_kind', 'funding_amount_unsafe'); END IF;

    IF _branch = 'poll' THEN
        SELECT f.* INTO _active FROM public.reward_funding_transactions f
        WHERE f.settlement_id = _root.id AND f.campaign_id = _campaign.id AND f.status = 'submitted'
          AND lower(f.funder_wallet) = lower(trim(_funder_wallet))
        ORDER BY f.created_at DESC LIMIT 1 FOR UPDATE;
    ELSE
        SELECT f.* INTO _active FROM public.reward_funding_transactions f
        WHERE f.settlement_id = _root.id AND f.campaign_id IS NULL AND f.status = 'submitted'
          AND lower(f.funder_wallet) = lower(trim(_funder_wallet))
        ORDER BY f.created_at DESC LIMIT 1 FOR UPDATE;
    END IF;
    IF FOUND THEN
        RETURN jsonb_build_object('result_kind','replay','intent_id',_active.id,'campaign_id',COALESCE(_campaign.id, _pcampaign_id),
          'settlement_id',_root.id,'reference',_active.reference,'vault_wallet',_active.vault_wallet,
          'reward_principal_luna',_active.reward_principal_luna::text,'fee_reserve_luna',_active.fee_reserve_luna::text,
          'amount_luna',_active.amount_luna::text,'submitted_transaction_hash',_active.submitted_transaction_hash,
          'confirmation_deadline',_active.confirmation_deadline,'created_at',_active.created_at);
    END IF;
    IF _root.status <> 'configured' THEN
        RETURN jsonb_build_object('result_kind','funding_conflict','state',_root.status);
    END IF;
    IF _branch = 'poll' THEN
        INSERT INTO public.reward_funding_transactions (
          campaign_id, settlement_id, creator_wallet, funder_wallet, reference, amount_luna, status,
          confirmation_deadline, vault_wallet, reward_principal_luna, fee_reserve_luna
        ) VALUES (
          _campaign.id, _root.id, _root.owner_wallet, _funder_wallet,
          'votum:fund:' || replace(gen_random_uuid()::text, '-', ''), _root.total_budget_luna, 'submitted',
          now() + (_horizon || ' minutes')::interval, _vault.vault_address_hex,
          _root.reward_principal_luna, _root.fee_reserve_luna
        ) RETURNING * INTO _intent;
    ELSE
        INSERT INTO public.reward_funding_transactions (
          campaign_id, settlement_id, creator_wallet, funder_wallet, reference, amount_luna, status,
          confirmation_deadline, vault_wallet, reward_principal_luna, fee_reserve_luna
        ) VALUES (
          NULL, _root.id, _root.owner_wallet, _funder_wallet,
          'votum:fund:' || replace(gen_random_uuid()::text, '-', ''), _root.total_budget_luna, 'submitted',
          now() + (_horizon || ' minutes')::interval, _vault.vault_address_hex,
          _root.reward_principal_luna, _root.fee_reserve_luna
        ) RETURNING * INTO _intent;
    END IF;
    UPDATE public.reward_settlements SET status = 'funding_pending', updated_at = now() WHERE id = _root.id;
    RETURN jsonb_build_object('result_kind','created','intent_id',_intent.id,'campaign_id',COALESCE(_campaign.id, _pcampaign_id),
      'settlement_id',_root.id,'reference',_intent.reference,'vault_wallet',_intent.vault_wallet,
      'reward_principal_luna',_intent.reward_principal_luna::text,'fee_reserve_luna',_intent.fee_reserve_luna::text,
      'amount_luna',_intent.amount_luna::text,'submitted_transaction_hash',_intent.submitted_transaction_hash,
      'confirmation_deadline',_intent.confirmation_deadline,'created_at',_intent.created_at);
END;
$$;

DROP FUNCTION IF EXISTS public.bind_reward_funding_transaction_atomic(uuid, uuid, text, text);
CREATE FUNCTION public.bind_reward_funding_transaction_atomic(
    _settlement_id uuid, _intent_id uuid, _funder_wallet text, _transaction_hash text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _root record; _campaign record; _pcampaign_id uuid; _branch text; _intent record; _hash text := lower(trim(COALESCE(_transaction_hash,''))); _lock bigint;
BEGIN
    SELECT * INTO _root FROM public.reward_settlements WHERE id = _settlement_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','settlement_not_found'); END IF;
    SELECT c.* INTO _campaign FROM public.reward_campaigns c JOIN public.settlement_source_bindings b
      ON b.reward_campaign_id=c.id AND b.source_type='poll_reward_campaign' AND b.settlement_id=_root.id;
    IF FOUND THEN
        _branch := 'poll';
    ELSE
        SELECT p.id INTO _pcampaign_id FROM public.participation_campaigns p
        JOIN public.settlement_source_bindings b ON b.participation_campaign_id=p.id
          AND b.source_type='participation_campaign' AND b.settlement_id=_root.id;
        IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','source_not_supported'); END IF;
        _branch := 'campaign';
    END IF;
    IF lower(_root.funding_wallet) <> lower(trim(_funder_wallet)) THEN RETURN jsonb_build_object('result_kind','funding_not_allowed'); END IF;
    IF _root.status <> 'funding_pending' THEN RETURN jsonb_build_object('result_kind','funding_conflict','state',_root.status); END IF;
    IF _hash !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('result_kind','invalid_hash'); END IF;
    _lock := ('x'||substr(_hash,1,15))::bit(64)::bigint; IF _lock=0 THEN _lock=1; END IF; PERFORM pg_advisory_xact_lock(_lock);
    IF _branch = 'poll' THEN
        SELECT f.* INTO _intent FROM public.reward_funding_transactions f
          WHERE f.id=_intent_id AND f.settlement_id=_root.id AND f.campaign_id=_campaign.id FOR UPDATE;
    ELSE
        SELECT f.* INTO _intent FROM public.reward_funding_transactions f
          WHERE f.id=_intent_id AND f.settlement_id=_root.id AND f.campaign_id IS NULL FOR UPDATE;
    END IF;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','intent_not_found'); END IF;
    IF lower(_intent.funder_wallet) <> lower(trim(_funder_wallet)) THEN RETURN jsonb_build_object('result_kind','funding_not_allowed'); END IF;
    IF _intent.submitted_transaction_hash = _hash THEN RETURN jsonb_build_object('result_kind','bound_replay','intent_id',_intent.id,'campaign_id',COALESCE(_campaign.id, _pcampaign_id),'settlement_id',_root.id,'reference',_intent.reference,'submitted_transaction_hash',_hash); END IF;
    IF _intent.submitted_transaction_hash IS NOT NULL THEN RETURN jsonb_build_object('result_kind','intent_already_bound'); END IF;
    IF _intent.status <> 'submitted' THEN RETURN jsonb_build_object('result_kind','intent_state_conflict','state',_intent.status); END IF;
    IF EXISTS (SELECT 1 FROM public.reward_funding_transactions f WHERE f.id<>_intent_id AND (f.submitted_transaction_hash=_hash OR f.confirmed_transaction_hash=_hash))
       OR EXISTS (SELECT 1 FROM public.nim_support_intents s WHERE s.submitted_transaction_hash=_hash)
       OR EXISTS (SELECT 1 FROM public.nim_contributions n WHERE n.transaction_hash=_hash)
       OR EXISTS (SELECT 1 FROM public.reward_payout_attempts p WHERE p.transaction_hash=_hash)
       OR EXISTS (SELECT 1 FROM public.reward_refunds r WHERE r.transaction_hash=_hash) THEN RETURN jsonb_build_object('result_kind','transaction_already_reserved'); END IF;
    UPDATE public.reward_funding_transactions SET submitted_transaction_hash=_hash, submitted_at=now(), updated_at=now() WHERE id=_intent_id;
    RETURN jsonb_build_object('result_kind','bound','intent_id',_intent_id,'campaign_id',COALESCE(_campaign.id, _pcampaign_id),'settlement_id',_root.id,'reference',_intent.reference,'submitted_transaction_hash',_hash);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('result_kind','transaction_already_reserved');
END;
$$;

DROP FUNCTION IF EXISTS public.confirm_reward_funding_atomic(uuid, uuid, text, bigint, bigint, timestamptz);
CREATE FUNCTION public.confirm_reward_funding_atomic(
    _settlement_id uuid, _intent_id uuid, _transaction_hash text, _observed_amount_luna bigint,
    _block_number bigint DEFAULT NULL, _transaction_timestamp timestamptz DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _root record; _campaign record; _pcampaign_id uuid; _branch text; _funding record; _vault record; _hash text:=lower(trim(COALESCE(_transaction_hash,''))); _excess bigint; _at timestamptz;
BEGIN
    IF _hash !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('result_kind','invalid_hash'); END IF;
    IF _observed_amount_luna IS NULL OR _observed_amount_luna < 0 THEN RETURN jsonb_build_object('result_kind','invalid_amount'); END IF;
    SELECT * INTO _root FROM public.reward_settlements WHERE id=_settlement_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','settlement_not_found'); END IF;
    SELECT c.* INTO _campaign FROM public.reward_campaigns c JOIN public.settlement_source_bindings b ON b.reward_campaign_id=c.id AND b.source_type='poll_reward_campaign' AND b.settlement_id=_root.id;
    IF FOUND THEN
        _branch := 'poll';
    ELSE
        SELECT p.id INTO _pcampaign_id FROM public.participation_campaigns p
        JOIN public.settlement_source_bindings b ON b.participation_campaign_id=p.id
          AND b.source_type='participation_campaign' AND b.settlement_id=_root.id;
        IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','source_not_supported'); END IF;
        _branch := 'campaign';
    END IF;
    IF _branch = 'poll' THEN
        SELECT f.* INTO _funding FROM public.reward_funding_transactions f WHERE f.id=_intent_id AND f.settlement_id=_root.id AND f.campaign_id=_campaign.id FOR UPDATE;
    ELSE
        SELECT f.* INTO _funding FROM public.reward_funding_transactions f WHERE f.id=_intent_id AND f.settlement_id=_root.id AND f.campaign_id IS NULL FOR UPDATE;
    END IF;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','intent_not_found'); END IF;
    IF _root.status <> 'funding_pending' THEN
      IF _root.status IN ('funded','rewarding','exhausted','closed','refunding','refunded') AND _funding.status='confirmed' AND lower(COALESCE(_funding.confirmed_transaction_hash,''))=_hash THEN
        RETURN jsonb_build_object('result_kind','replay','campaign_id',COALESCE(_campaign.id, _pcampaign_id),'settlement_id',_root.id,'intent_id',_funding.id,'transaction_hash',_funding.confirmed_transaction_hash,'required_amount_luna',_root.total_budget_luna::text,'observed_amount_luna',_root.funded_amount_luna::text,'refundable_excess_luna',_root.refundable_excess_luna::text,'funded_at',_root.funded_at,'confirmed_at',_funding.confirmed_at);
      END IF;
      RETURN jsonb_build_object('result_kind','funding_conflict','state',_root.status);
    END IF;
    IF _funding.status<>'submitted' THEN RETURN jsonb_build_object('result_kind','intent_state_conflict','state',_funding.status); END IF;
    IF _funding.submitted_transaction_hash IS NULL THEN RETURN jsonb_build_object('result_kind','intent_unbound'); END IF;
    IF lower(_funding.submitted_transaction_hash)<>_hash THEN RETURN jsonb_build_object('result_kind','hash_mismatch'); END IF;
    SELECT v.vault_address_hex INTO _vault FROM public.reward_campaign_vaults v WHERE v.settlement_id=_root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','vault_missing'); END IF;
    IF _funding.vault_wallet IS NULL OR lower(_funding.vault_wallet)<>lower(_vault.vault_address_hex) OR _funding.amount_luna<>_root.total_budget_luna OR _funding.reward_principal_luna IS DISTINCT FROM _root.reward_principal_luna OR _funding.fee_reserve_luna IS DISTINCT FROM _root.fee_reserve_luna THEN RETURN jsonb_build_object('result_kind','funding_terms_mismatch'); END IF;
    IF _observed_amount_luna<_root.total_budget_luna THEN RETURN jsonb_build_object('result_kind','amount_underpaid','required_amount_luna',_root.total_budget_luna::text,'observed_amount_luna',_observed_amount_luna::text); END IF;
    _excess:=_observed_amount_luna-_root.total_budget_luna; _at:=now();
    UPDATE public.reward_funding_transactions SET status='confirmed',confirmed_transaction_hash=_hash,block_number=_block_number,transaction_timestamp=_transaction_timestamp,confirmed_at=_at,updated_at=_at WHERE id=_funding.id;
    UPDATE public.reward_settlements SET status='funded',funded_amount_luna=_observed_amount_luna,refundable_excess_luna=_excess,funded_at=_at,updated_at=_at WHERE id=_root.id;
    RETURN jsonb_build_object('result_kind','confirmed','campaign_id',COALESCE(_campaign.id, _pcampaign_id),'settlement_id',_root.id,'intent_id',_funding.id,'transaction_hash',_hash,'required_amount_luna',_root.total_budget_luna::text,'observed_amount_luna',_observed_amount_luna::text,'refundable_excess_luna',_excess::text,'funded_at',_at,'confirmed_at',_at);
END;
$$;

-- ============================================================================
-- Grants and ownership parity with the cutover contract.
-- ============================================================================

REVOKE ALL ON FUNCTION public.begin_reward_funding_atomic(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bind_reward_funding_transaction_atomic(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_reward_funding_atomic(uuid, uuid, text, bigint, bigint, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_reward_funding_atomic(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_reward_funding_transaction_atomic(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_reward_funding_atomic(uuid, uuid, text, bigint, bigint, timestamptz) TO service_role;
