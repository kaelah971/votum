-- V2C.2E — switch mutable Poll financial authority to reward_settlements.
--
-- This is the only authority-switch migration.  The migration is deliberately
-- fail-closed: it locks the financial tables, resynchronizes the new root from
-- the current Poll adapter, validates every relationship, and only then swaps
-- the vault identity and replaces the financial RPCs.  reward_campaigns remains
-- a Poll compatibility/source row; it is never dual-written after this point.
--
-- Wrapped in an explicit transaction so the LOCK below executes inside a
-- transaction block on every migration runner (start and reset paths).

BEGIN;

LOCK TABLE public.reward_campaigns,
           public.reward_settlements,
           public.settlement_source_bindings,
           public.reward_funding_transactions,
           public.reward_receipts,
           public.reward_payout_attempts,
           public.reward_refunds,
           public.reward_campaign_vaults
  IN SHARE ROW EXCLUSIVE MODE;

-- ==========================================================================
-- Phase C resync and validation
-- ==========================================================================

DO $$
DECLARE
    _bad record;
BEGIN
    -- The Poll adapter is the only source allowed to resynchronize a root.
    UPDATE public.reward_settlements s
    SET owner_wallet = c.creator_wallet,
        funding_wallet = c.funding_wallet,
        refund_recipient_wallet = c.creator_wallet,
        funding_mode = c.funding_mode,
        asset = c.asset,
        reward_per_participant_luna = c.reward_per_participant_luna,
        max_rewarded_participants = c.max_rewarded_participants,
        reward_principal_luna = c.reward_principal_luna,
        fee_reserve_luna = c.fee_reserve_luna,
        total_budget_luna = c.total_budget_luna,
        status = c.status,
        funded_amount_luna = c.funded_amount_luna,
        refundable_excess_luna = c.refundable_excess_luna,
        rewarded_participant_count = c.rewarded_participant_count,
        paid_amount_luna = c.paid_amount_luna,
        fee_spent_luna = c.fee_spent_luna,
        refundable_amount_luna = c.refundable_amount_luna,
        first_reservation_at = c.first_reservation_at,
        payout_lock_attempt_id = c.payout_lock_attempt_id,
        payout_lock_expires_at = c.payout_lock_expires_at,
        payout_lock_token = c.payout_lock_token,
        created_at = c.created_at,
        funded_at = c.funded_at,
        closed_at = c.closed_at,
        refunded_at = c.refunded_at,
        updated_at = c.updated_at
    FROM public.reward_campaigns c
    JOIN public.settlement_source_bindings b
      ON b.reward_campaign_id = c.id
     AND b.source_type = 'poll_reward_campaign'
     AND b.settlement_id = c.settlement_id
    WHERE s.id = c.settlement_id;

    UPDATE public.reward_funding_transactions f
    SET settlement_id = c.settlement_id
    FROM public.reward_campaigns c
    JOIN public.settlement_source_bindings b
      ON b.reward_campaign_id = c.id
     AND b.source_type = 'poll_reward_campaign'
     AND b.settlement_id = c.settlement_id
    WHERE f.campaign_id = c.id;

    UPDATE public.reward_receipts r
    SET settlement_id = c.settlement_id
    FROM public.reward_campaigns c
    JOIN public.settlement_source_bindings b
      ON b.reward_campaign_id = c.id
     AND b.source_type = 'poll_reward_campaign'
     AND b.settlement_id = c.settlement_id
    WHERE r.campaign_id = c.id;

    UPDATE public.reward_refunds r
    SET settlement_id = c.settlement_id
    FROM public.reward_campaigns c
    JOIN public.settlement_source_bindings b
      ON b.reward_campaign_id = c.id
     AND b.source_type = 'poll_reward_campaign'
     AND b.settlement_id = c.settlement_id
    WHERE r.campaign_id = c.id;

    UPDATE public.reward_campaign_vaults v
    SET settlement_id = c.settlement_id
    FROM public.reward_campaigns c
    JOIN public.settlement_source_bindings b
      ON b.reward_campaign_id = c.id
     AND b.source_type = 'poll_reward_campaign'
     AND b.settlement_id = c.settlement_id
    WHERE v.campaign_id = c.id;

    SELECT c.id, 'poll campaign without settlement root' AS invariant
    INTO _bad
    FROM public.reward_campaigns c
    LEFT JOIN public.reward_settlements s ON s.id = c.settlement_id
    LEFT JOIN public.settlement_source_bindings b
      ON b.reward_campaign_id = c.id
     AND b.source_type = 'poll_reward_campaign'
    WHERE c.settlement_id IS NULL OR s.id IS NULL
       OR b.settlement_id IS DISTINCT FROM c.settlement_id
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'v2c2e cutover blocked: row_id=% invariant=%', _bad.id, _bad.invariant
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT s.id, 'settlement root/source mismatch' AS invariant
    INTO _bad
    FROM public.reward_settlements s
    LEFT JOIN public.settlement_source_bindings b ON b.settlement_id = s.id
    LEFT JOIN public.reward_campaigns c
      ON c.id = b.reward_campaign_id
     AND b.source_type = 'poll_reward_campaign'
    WHERE b.settlement_id IS NULL
       OR (b.source_type = 'poll_reward_campaign' AND c.id IS NULL)
    LIMIT 1;
    IF FOUND THEN
        -- Standalone Campaign roots are valid and are intentionally not yet
        -- present in this slice; every existing root must have a Poll source.
        RAISE EXCEPTION 'v2c2e cutover blocked: row_id=% invariant=%', _bad.id, _bad.invariant
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT f.id, 'funding child settlement mismatch' AS invariant
    INTO _bad
    FROM public.reward_funding_transactions f
    LEFT JOIN public.reward_campaigns c ON c.id = f.campaign_id
    WHERE f.settlement_id IS NULL OR c.settlement_id IS DISTINCT FROM f.settlement_id
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'v2c2e cutover blocked: row_id=% invariant=%', _bad.id, _bad.invariant
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT r.id, 'receipt child settlement mismatch' AS invariant
    INTO _bad
    FROM public.reward_receipts r
    LEFT JOIN public.reward_campaigns c ON c.id = r.campaign_id
    WHERE r.settlement_id IS NULL OR c.settlement_id IS DISTINCT FROM r.settlement_id
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'v2c2e cutover blocked: row_id=% invariant=%', _bad.id, _bad.invariant
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT r.id, 'refund child settlement mismatch' AS invariant
    INTO _bad
    FROM public.reward_refunds r
    LEFT JOIN public.reward_campaigns c ON c.id = r.campaign_id
    WHERE r.settlement_id IS NULL OR c.settlement_id IS DISTINCT FROM r.settlement_id
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'v2c2e cutover blocked: row_id=% invariant=%', _bad.id, _bad.invariant
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT v.campaign_id, 'vault child settlement mismatch' AS invariant
    INTO _bad
    FROM public.reward_campaign_vaults v
    LEFT JOIN public.reward_campaigns c ON c.id = v.campaign_id
    WHERE v.settlement_id IS NULL OR c.settlement_id IS DISTINCT FROM v.settlement_id
    LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'v2c2e cutover blocked: row_id=% invariant=%', _bad.campaign_id, _bad.invariant
            USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.reward_campaign_vaults
        GROUP BY settlement_id HAVING COUNT(*) <> 1
    ) THEN
        RAISE EXCEPTION 'v2c2e cutover blocked: vault uniqueness mismatch'
            USING ERRCODE = 'unique_violation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.reward_campaigns c
        JOIN public.reward_settlements s ON s.id = c.settlement_id
        WHERE c.creator_wallet <> s.owner_wallet
           OR c.funding_wallet <> s.funding_wallet
           OR c.reward_per_participant_luna <> s.reward_per_participant_luna
           OR c.max_rewarded_participants <> s.max_rewarded_participants
           OR c.reward_principal_luna <> s.reward_principal_luna
           OR c.fee_reserve_luna <> s.fee_reserve_luna
           OR c.total_budget_luna <> s.total_budget_luna
           OR c.status <> s.status
           OR c.funded_amount_luna <> s.funded_amount_luna
           OR c.refundable_excess_luna <> s.refundable_excess_luna
           OR c.rewarded_participant_count <> s.rewarded_participant_count
           OR c.paid_amount_luna <> s.paid_amount_luna
           OR c.fee_spent_luna <> s.fee_spent_luna
           OR c.refundable_amount_luna <> s.refundable_amount_luna
           OR c.first_reservation_at IS DISTINCT FROM s.first_reservation_at
           OR c.payout_lock_attempt_id IS DISTINCT FROM s.payout_lock_attempt_id
           OR c.payout_lock_expires_at IS DISTINCT FROM s.payout_lock_expires_at
           OR c.payout_lock_token IS DISTINCT FROM s.payout_lock_token
    ) THEN
        RAISE EXCEPTION 'v2c2e cutover blocked: root resync mismatch'
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$;

-- The old Poll row is now an immutable compatibility/source record.  In
-- particular, a service-role UPDATE cannot silently create a second authority.
CREATE OR REPLACE FUNCTION public.prevent_reward_campaign_refund_freeze()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Existing isolated Poll fixtures may still need the one-time stable
    -- backfill binding. It can only point a previously unbound compatibility
    -- row at the root with the same UUID; all other compatibility fields and
    -- every subsequent binding change remain immutable.
    IF NEW.settlement_id IS DISTINCT FROM OLD.settlement_id
       AND (
         OLD.settlement_id IS NOT NULL
         OR NEW.settlement_id IS NULL
         OR NEW.settlement_id <> OLD.id
         OR NOT EXISTS (
           SELECT 1 FROM public.reward_settlements s WHERE s.id = NEW.settlement_id
         )
       ) THEN
         RAISE EXCEPTION 'reward campaign compatibility row is immutable'
             USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.poll_id IS DISTINCT FROM OLD.poll_id
       OR NEW.creator_wallet IS DISTINCT FROM OLD.creator_wallet
       OR NEW.funding_mode IS DISTINCT FROM OLD.funding_mode
       OR NEW.funding_wallet IS DISTINCT FROM OLD.funding_wallet
       OR NEW.reward_per_participant_luna IS DISTINCT FROM OLD.reward_per_participant_luna
       OR NEW.max_rewarded_participants IS DISTINCT FROM OLD.max_rewarded_participants
       OR NEW.reward_principal_luna IS DISTINCT FROM OLD.reward_principal_luna
       OR NEW.fee_reserve_luna IS DISTINCT FROM OLD.fee_reserve_luna
       OR NEW.total_budget_luna IS DISTINCT FROM OLD.total_budget_luna
       OR NEW.asset IS DISTINCT FROM OLD.asset
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.funded_amount_luna IS DISTINCT FROM OLD.funded_amount_luna
       OR NEW.refundable_excess_luna IS DISTINCT FROM OLD.refundable_excess_luna
       OR NEW.rewarded_participant_count IS DISTINCT FROM OLD.rewarded_participant_count
       OR NEW.paid_amount_luna IS DISTINCT FROM OLD.paid_amount_luna
       OR NEW.fee_spent_luna IS DISTINCT FROM OLD.fee_spent_luna
       OR NEW.refundable_amount_luna IS DISTINCT FROM OLD.refundable_amount_luna
       OR NEW.first_reservation_at IS DISTINCT FROM OLD.first_reservation_at
       OR NEW.vault_wallet IS DISTINCT FROM OLD.vault_wallet
       OR NEW.vault_key_ref IS DISTINCT FROM OLD.vault_key_ref
       OR NEW.payout_lock_attempt_id IS DISTINCT FROM OLD.payout_lock_attempt_id
       OR NEW.payout_lock_expires_at IS DISTINCT FROM OLD.payout_lock_expires_at
       OR NEW.payout_lock_token IS DISTINCT FROM OLD.payout_lock_token THEN
        RAISE EXCEPTION 'reward campaign compatibility row is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

-- Root-side refund/economic freeze.  This is the backstop used by all new
-- refund transitions; the old campaign trigger is retained only for legacy
-- callers and no longer owns state.
CREATE OR REPLACE FUNCTION public.prevent_reward_settlement_refund_freeze()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF OLD.status = 'closed' AND NEW.status NOT IN ('closed', 'refunding', 'refunded') THEN
        RAISE EXCEPTION 'closed settlement cannot be reopened' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'closed' AND NEW.status = 'refunding' AND NOT EXISTS (
        SELECT 1 FROM public.reward_refunds r
        WHERE r.settlement_id = NEW.id AND r.status = 'pending'
          AND r.amount_luna = NEW.refundable_amount_luna
    ) THEN
        RAISE EXCEPTION 'refunding settlement requires a pending refund intent' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'refunding' AND NEW.status NOT IN ('refunding', 'refunded') THEN
        RAISE EXCEPTION 'refunding settlement cannot be reopened' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'refunded' AND NEW.status <> 'refunded' THEN
        RAISE EXCEPTION 'refunded settlement cannot be reopened' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'refunding' AND NEW.status = 'refunded' AND NOT EXISTS (
        SELECT 1 FROM public.reward_refunds r
        WHERE r.settlement_id = NEW.id AND r.status = 'confirmed' AND r.transaction_hash IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'refunded settlement requires a confirmed refund proof' USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.status IN ('closed', 'refunding', 'refunded') AND (
        NEW.owner_wallet IS DISTINCT FROM OLD.owner_wallet
        OR NEW.funding_wallet IS DISTINCT FROM OLD.funding_wallet
        OR NEW.refund_recipient_wallet IS DISTINCT FROM OLD.refund_recipient_wallet
        OR NEW.funding_mode IS DISTINCT FROM OLD.funding_mode
        OR NEW.asset IS DISTINCT FROM OLD.asset
        OR NEW.reward_per_participant_luna IS DISTINCT FROM OLD.reward_per_participant_luna
        OR NEW.max_rewarded_participants IS DISTINCT FROM OLD.max_rewarded_participants
        OR NEW.reward_principal_luna IS DISTINCT FROM OLD.reward_principal_luna
        OR NEW.fee_reserve_luna IS DISTINCT FROM OLD.fee_reserve_luna
        OR NEW.total_budget_luna IS DISTINCT FROM OLD.total_budget_luna
        OR NEW.funded_amount_luna IS DISTINCT FROM OLD.funded_amount_luna
        OR NEW.rewarded_participant_count IS DISTINCT FROM OLD.rewarded_participant_count
        OR NEW.paid_amount_luna IS DISTINCT FROM OLD.paid_amount_luna
        OR NEW.fee_spent_luna IS DISTINCT FROM OLD.fee_spent_luna
        OR NEW.refundable_excess_luna IS DISTINCT FROM OLD.refundable_excess_luna
         OR NEW.first_reservation_at IS DISTINCT FROM OLD.first_reservation_at
        OR (NOT (OLD.status = 'closed' AND NEW.status = 'refunding')
            AND NEW.refundable_amount_luna IS DISTINCT FROM OLD.refundable_amount_luna)
    ) THEN
        RAISE EXCEPTION 'settlement economics are frozen after refund preparation'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reward_settlement_refund_freeze_guard ON public.reward_settlements;
CREATE TRIGGER reward_settlement_refund_freeze_guard
  BEFORE UPDATE ON public.reward_settlements
  FOR EACH ROW EXECUTE FUNCTION public.prevent_reward_settlement_refund_freeze();

-- All obligation guards now lock the settlement root, not the compatibility
-- campaign row.  The trigger names remain stable for existing deployments.
CREATE OR REPLACE FUNCTION public.prevent_reward_receipt_after_refund_freeze()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _settlement_id uuid;
    _status text;
BEGIN
    _settlement_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.settlement_id ELSE NEW.settlement_id END;
    SELECT s.status INTO _status FROM public.reward_settlements s
    WHERE s.id = _settlement_id FOR UPDATE;
    IF _status IN ('closed', 'refunding', 'refunded') THEN
        RAISE EXCEPTION 'reward obligations are blocked after refund preparation' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.settlement_id IS DISTINCT FROM OLD.settlement_id THEN
        SELECT s.status INTO _status FROM public.reward_settlements s
        WHERE s.id = OLD.settlement_id FOR UPDATE;
        IF _status IN ('closed', 'refunding', 'refunded') THEN
            RAISE EXCEPTION 'reward obligations are blocked after refund preparation' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_reward_payout_after_refund_freeze()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _settlement_id uuid;
    _status text;
BEGIN
    SELECT r.settlement_id INTO _settlement_id
    FROM public.reward_payout_attempts a
    JOIN public.reward_receipts r ON r.id = CASE WHEN TG_OP = 'DELETE' THEN a.receipt_id ELSE a.receipt_id END
    WHERE a.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
    IF TG_OP <> 'DELETE' AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id THEN
        SELECT settlement_id INTO _settlement_id FROM public.reward_receipts WHERE id = OLD.receipt_id;
    END IF;
    SELECT s.status INTO _status FROM public.reward_settlements s
    WHERE s.id = _settlement_id FOR UPDATE;
    IF _status IN ('closed', 'refunding', 'refunded') THEN
        RAISE EXCEPTION 'payout obligations are blocked after refund preparation' USING ERRCODE = 'check_violation';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- The payout fee trigger is part of the root ledger now.
CREATE OR REPLACE FUNCTION public.account_reward_payout_fee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _settlement_id uuid;
    _was_confirmed boolean;
BEGIN
    _was_confirmed := CASE WHEN TG_OP = 'INSERT' THEN false ELSE OLD.status = 'confirmed' END;
    IF NOT _was_confirmed AND NEW.status = 'confirmed' THEN
        IF NEW.fee_luna IS NULL OR NEW.fee_luna < 0 THEN
            RAISE EXCEPTION 'confirmed payout requires a non-negative fee' USING ERRCODE = 'check_violation';
        END IF;
        SELECT r.settlement_id INTO _settlement_id
        FROM public.reward_receipts r WHERE r.id = NEW.receipt_id;
        IF _settlement_id IS NULL THEN
            RAISE EXCEPTION 'confirmed payout receipt not found' USING ERRCODE = 'foreign_key_violation';
        END IF;
        UPDATE public.reward_settlements
        SET fee_spent_luna = fee_spent_luna + NEW.fee_luna, updated_at = now()
        WHERE id = _settlement_id;
    END IF;
    RETURN NEW;
END;
$$;

-- ==========================================================================
-- Funding and Poll reservation RPCs
-- ==========================================================================

DROP FUNCTION IF EXISTS public.begin_reward_funding_atomic(uuid, text, integer);
CREATE OR REPLACE FUNCTION public.begin_reward_funding_atomic(
    _campaign_id uuid,
    _funder_wallet text,
    _confirmation_horizon_minutes integer DEFAULT 60
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    _root record;
    _campaign record;
    _poll_public boolean;
    _vault record;
    _active record;
    _intent record;
    _horizon integer := GREATEST(5, LEAST(COALESCE(_confirmation_horizon_minutes, 60), 1440));
BEGIN
    SELECT * INTO _root FROM public.reward_settlements WHERE id = _campaign_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind', 'campaign_not_found'); END IF;
    SELECT c.* INTO _campaign FROM public.reward_campaigns c
    JOIN public.settlement_source_bindings b ON b.reward_campaign_id = c.id
      AND b.source_type = 'poll_reward_campaign' AND b.settlement_id = _root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind', 'campaign_not_found'); END IF;
    IF lower(_root.funding_wallet) <> lower(trim(_funder_wallet)) THEN RETURN jsonb_build_object('result_kind', 'forbidden'); END IF;
    SELECT p.is_public INTO _poll_public FROM public.polls p WHERE p.id = _campaign.poll_id;
    IF NOT COALESCE(_poll_public, false) THEN RETURN jsonb_build_object('result_kind', 'poll_not_public'); END IF;
    SELECT v.vault_address_hex INTO _vault FROM public.reward_campaign_vaults v WHERE v.settlement_id = _root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind', 'vault_missing'); END IF;
    IF _root.total_budget_luna > 9007199254740991::bigint THEN RETURN jsonb_build_object('result_kind', 'funding_amount_unsafe'); END IF;

    SELECT f.* INTO _active FROM public.reward_funding_transactions f
    WHERE f.settlement_id = _root.id AND f.status = 'submitted'
      AND lower(f.funder_wallet) = lower(trim(_funder_wallet))
    ORDER BY f.created_at DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
        RETURN jsonb_build_object('result_kind','replay','intent_id',_active.id,'campaign_id',_campaign.id,
          'settlement_id',_root.id,'reference',_active.reference,'vault_wallet',_active.vault_wallet,
          'reward_principal_luna',_active.reward_principal_luna::text,'fee_reserve_luna',_active.fee_reserve_luna::text,
          'amount_luna',_active.amount_luna::text,'submitted_transaction_hash',_active.submitted_transaction_hash,
          'confirmation_deadline',_active.confirmation_deadline,'created_at',_active.created_at);
    END IF;
    IF _root.status <> 'configured' THEN
        RETURN jsonb_build_object('result_kind','campaign_state_conflict','state',_root.status);
    END IF;
    INSERT INTO public.reward_funding_transactions (
      campaign_id, settlement_id, creator_wallet, funder_wallet, reference, amount_luna, status,
      confirmation_deadline, vault_wallet, reward_principal_luna, fee_reserve_luna
    ) VALUES (
      _campaign.id, _root.id, _root.owner_wallet, _funder_wallet,
      'votum:fund:' || replace(gen_random_uuid()::text, '-', ''), _root.total_budget_luna, 'submitted',
      now() + (_horizon || ' minutes')::interval, _vault.vault_address_hex,
      _root.reward_principal_luna, _root.fee_reserve_luna
    ) RETURNING * INTO _intent;
    UPDATE public.reward_settlements SET status = 'funding_pending', updated_at = now() WHERE id = _root.id;
    RETURN jsonb_build_object('result_kind','created','intent_id',_intent.id,'campaign_id',_campaign.id,
      'settlement_id',_root.id,'reference',_intent.reference,'vault_wallet',_intent.vault_wallet,
      'reward_principal_luna',_intent.reward_principal_luna::text,'fee_reserve_luna',_intent.fee_reserve_luna::text,
      'amount_luna',_intent.amount_luna::text,'submitted_transaction_hash',_intent.submitted_transaction_hash,
      'confirmation_deadline',_intent.confirmation_deadline,'created_at',_intent.created_at);
END;
$$;

DROP FUNCTION IF EXISTS public.bind_reward_funding_transaction_atomic(uuid, uuid, text, text);
CREATE OR REPLACE FUNCTION public.bind_reward_funding_transaction_atomic(
    _campaign_id uuid, _intent_id uuid, _funder_wallet text, _transaction_hash text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _root record; _campaign record; _intent record; _hash text := lower(trim(COALESCE(_transaction_hash,''))); _lock bigint;
BEGIN
    SELECT * INTO _root FROM public.reward_settlements WHERE id = _campaign_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    SELECT c.* INTO _campaign FROM public.reward_campaigns c JOIN public.settlement_source_bindings b
      ON b.reward_campaign_id=c.id AND b.source_type='poll_reward_campaign' AND b.settlement_id=_root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    IF lower(_root.funding_wallet) <> lower(trim(_funder_wallet)) THEN RETURN jsonb_build_object('result_kind','forbidden'); END IF;
    IF _root.status <> 'funding_pending' THEN RETURN jsonb_build_object('result_kind','campaign_state_conflict','state',_root.status); END IF;
    IF _hash !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('result_kind','invalid_hash'); END IF;
    _lock := ('x'||substr(_hash,1,15))::bit(64)::bigint; IF _lock=0 THEN _lock=1; END IF; PERFORM pg_advisory_xact_lock(_lock);
    SELECT f.* INTO _intent FROM public.reward_funding_transactions f
      WHERE f.id=_intent_id AND f.settlement_id=_root.id AND f.campaign_id=_campaign.id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','intent_not_found'); END IF;
    IF lower(_intent.funder_wallet) <> lower(trim(_funder_wallet)) THEN RETURN jsonb_build_object('result_kind','forbidden'); END IF;
    IF _intent.submitted_transaction_hash = _hash THEN RETURN jsonb_build_object('result_kind','bound_replay','intent_id',_intent.id,'campaign_id',_campaign.id,'settlement_id',_root.id,'reference',_intent.reference,'submitted_transaction_hash',_hash); END IF;
    IF _intent.submitted_transaction_hash IS NOT NULL THEN RETURN jsonb_build_object('result_kind','intent_already_bound'); END IF;
    IF _intent.status <> 'submitted' THEN RETURN jsonb_build_object('result_kind','intent_state_conflict','state',_intent.status); END IF;
    IF EXISTS (SELECT 1 FROM public.reward_funding_transactions f WHERE f.id<>_intent_id AND (f.submitted_transaction_hash=_hash OR f.confirmed_transaction_hash=_hash))
       OR EXISTS (SELECT 1 FROM public.nim_support_intents s WHERE s.submitted_transaction_hash=_hash)
       OR EXISTS (SELECT 1 FROM public.nim_contributions n WHERE n.transaction_hash=_hash)
       OR EXISTS (SELECT 1 FROM public.reward_payout_attempts p WHERE p.transaction_hash=_hash)
       OR EXISTS (SELECT 1 FROM public.reward_refunds r WHERE r.transaction_hash=_hash) THEN RETURN jsonb_build_object('result_kind','transaction_already_reserved'); END IF;
    UPDATE public.reward_funding_transactions SET submitted_transaction_hash=_hash, submitted_at=now(), updated_at=now() WHERE id=_intent_id;
    RETURN jsonb_build_object('result_kind','bound','intent_id',_intent_id,'campaign_id',_campaign.id,'settlement_id',_root.id,'reference',_intent.reference,'submitted_transaction_hash',_hash);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('result_kind','transaction_already_reserved');
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_reward_funding_atomic(
    _campaign_id uuid, _intent_id uuid, _transaction_hash text, _observed_amount_luna bigint,
    _block_number bigint DEFAULT NULL, _transaction_timestamp timestamptz DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _root record; _campaign record; _funding record; _vault record; _hash text:=lower(trim(COALESCE(_transaction_hash,''))); _excess bigint; _at timestamptz;
BEGIN
    IF _hash !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('result_kind','invalid_hash'); END IF;
    IF _observed_amount_luna IS NULL OR _observed_amount_luna < 0 THEN RETURN jsonb_build_object('result_kind','invalid_amount'); END IF;
    SELECT * INTO _root FROM public.reward_settlements WHERE id=_campaign_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    SELECT c.* INTO _campaign FROM public.reward_campaigns c JOIN public.settlement_source_bindings b ON b.reward_campaign_id=c.id AND b.source_type='poll_reward_campaign' AND b.settlement_id=_root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    SELECT f.* INTO _funding FROM public.reward_funding_transactions f WHERE f.id=_intent_id AND f.settlement_id=_root.id AND f.campaign_id=_campaign.id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','intent_not_found'); END IF;
    IF _root.status <> 'funding_pending' THEN
      IF _root.status IN ('funded','rewarding','exhausted','closed','refunding','refunded') AND _funding.status='confirmed' AND lower(COALESCE(_funding.confirmed_transaction_hash,''))=_hash THEN
        RETURN jsonb_build_object('result_kind','replay','campaign_id',_campaign.id,'settlement_id',_root.id,'intent_id',_funding.id,'transaction_hash',_funding.confirmed_transaction_hash,'required_amount_luna',_root.total_budget_luna::text,'observed_amount_luna',_root.funded_amount_luna::text,'refundable_excess_luna',_root.refundable_excess_luna::text,'funded_at',_root.funded_at,'confirmed_at',_funding.confirmed_at);
      END IF;
      RETURN jsonb_build_object('result_kind','campaign_state_conflict','state',_root.status);
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
    RETURN jsonb_build_object('result_kind','confirmed','campaign_id',_campaign.id,'settlement_id',_root.id,'intent_id',_funding.id,'transaction_hash',_hash,'required_amount_luna',_root.total_budget_luna::text,'observed_amount_luna',_observed_amount_luna::text,'refundable_excess_luna',_excess::text,'funded_at',_at,'confirmed_at',_at);
END;
$$;

-- Poll vote reservation: campaign_id is accepted only as the compatibility
-- input used by existing callers; it is resolved through the root binding.
CREATE OR REPLACE FUNCTION public.claim_reward_receipt_atomic(_participation_id uuid, _campaign_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _root record; _campaign record; _poll record; _vote record; _existing record; _receipt_id uuid; _next integer; _next_status text; _now timestamptz:=now();
BEGIN
    SELECT * INTO _root FROM public.reward_settlements WHERE id=_campaign_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    SELECT c.* INTO _campaign FROM public.reward_campaigns c JOIN public.settlement_source_bindings b ON b.reward_campaign_id=c.id AND b.source_type='poll_reward_campaign' AND b.settlement_id=_root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    SELECT v.id,v.poll_id,v.voter_wallet INTO _vote FROM public.poll_votes v WHERE v.id=_participation_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','participation_not_found'); END IF;
    IF _vote.poll_id<>_campaign.poll_id THEN RETURN jsonb_build_object('result_kind','participation_poll_mismatch','campaign_id',_campaign.id,'settlement_id',_root.id,'participation_id',_vote.id); END IF;
    SELECT p.id,p.creator_wallet,p.economic_model,p.reward_mode,p.is_public,p.status INTO _poll FROM public.polls p WHERE p.id=_vote.poll_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','participation_not_found'); END IF;
    IF NOT _poll.is_public OR _poll.status NOT IN ('live','closed') THEN RETURN jsonb_build_object('result_kind','poll_not_public','campaign_id',_campaign.id,'settlement_id',_root.id); END IF;
    IF _poll.economic_model IS DISTINCT FROM 'reward_first' OR _poll.reward_mode IS DISTINCT FROM 'rewarded' THEN RETURN jsonb_build_object('result_kind','poll_not_rewarded','campaign_id',_campaign.id,'settlement_id',_root.id); END IF;
    IF _root.owner_wallet<>lower(trim(_poll.creator_wallet)) THEN RETURN jsonb_build_object('result_kind','campaign_not_reservable','campaign_id',_campaign.id,'settlement_id',_root.id); END IF;
    IF _root.status IN ('configured','funding_pending') THEN RETURN jsonb_build_object('result_kind','campaign_not_funded','campaign_id',_campaign.id,'settlement_id',_root.id); END IF;
    IF _root.status NOT IN ('funded','rewarding','exhausted') THEN RETURN jsonb_build_object('result_kind','campaign_not_reservable','campaign_id',_campaign.id,'settlement_id',_root.id); END IF;
    IF lower(trim(_vote.voter_wallet))=lower(trim(_poll.creator_wallet)) THEN RETURN jsonb_build_object('result_kind','creator_not_reward_eligible','campaign_id',_campaign.id,'settlement_id',_root.id,'participation_id',_vote.id); END IF;
    SELECT r.id,r.amount_luna,r.status INTO _existing FROM public.reward_receipts r WHERE r.settlement_id=_root.id AND lower(trim(r.participant_wallet))=lower(trim(_vote.voter_wallet));
    IF FOUND THEN RETURN jsonb_build_object('result_kind','replay','receipt_id',_existing.id,'campaign_id',_campaign.id,'settlement_id',_root.id,'poll_id',_campaign.poll_id,'participant_wallet',_vote.voter_wallet,'amount_luna',_existing.amount_luna,'status',_existing.status); END IF;
    IF _root.status='exhausted' OR _root.rewarded_participant_count>=_root.max_rewarded_participants THEN RETURN jsonb_build_object('result_kind','no_reward_capacity','campaign_id',_campaign.id,'settlement_id',_root.id); END IF;
    _next:=_root.rewarded_participant_count+1; _next_status:=CASE WHEN _next>=_root.max_rewarded_participants THEN 'exhausted' ELSE 'rewarding' END;
    INSERT INTO public.reward_receipts(campaign_id,settlement_id,poll_id,participant_wallet,amount_luna,status) VALUES(_campaign.id,_root.id,_campaign.poll_id,_vote.voter_wallet,_root.reward_per_participant_luna,'reserved') ON CONFLICT(campaign_id,participant_wallet) DO NOTHING RETURNING id INTO _receipt_id;
    IF _receipt_id IS NULL THEN SELECT r.id,r.amount_luna,r.status INTO _existing FROM public.reward_receipts r WHERE r.settlement_id=_root.id AND lower(trim(r.participant_wallet))=lower(trim(_vote.voter_wallet)); RETURN jsonb_build_object('result_kind','replay','receipt_id',_existing.id,'campaign_id',_campaign.id,'settlement_id',_root.id,'poll_id',_campaign.poll_id,'participant_wallet',_vote.voter_wallet,'amount_luna',_existing.amount_luna,'status',_existing.status); END IF;
    UPDATE public.reward_settlements SET rewarded_participant_count=_next,status=_next_status,first_reservation_at=COALESCE(first_reservation_at,_now),updated_at=_now WHERE id=_root.id;
    RETURN jsonb_build_object('result_kind','reserved','receipt_id',_receipt_id,'campaign_id',_campaign.id,'settlement_id',_root.id,'poll_id',_campaign.poll_id,'participation_id',_vote.id,'participant_wallet',_vote.voter_wallet,'amount_luna',_root.reward_per_participant_luna,'status','reserved','campaign_status',_next_status,'rewarded_participant_count',_next,'rewards_remaining',_root.max_rewarded_participants-_next);
END;
$$;

-- ==========================================================================
-- Payout preparation, lease, and finality RPCs
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.begin_reward_payout_atomic(_receipt_id uuid, _campaign_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _root record; _campaign record; _receipt record; _vault record; _attempt record; _n integer;
BEGIN
    SELECT * INTO _root FROM public.reward_settlements WHERE id=_campaign_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    SELECT c.* INTO _campaign FROM public.reward_campaigns c JOIN public.settlement_source_bindings b ON b.reward_campaign_id=c.id AND b.source_type='poll_reward_campaign' AND b.settlement_id=_root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    SELECT r.id,r.campaign_id,r.settlement_id,r.poll_id,r.participant_wallet,r.amount_luna,r.status INTO _receipt
      FROM public.reward_receipts r WHERE r.id=_receipt_id AND r.settlement_id=_root.id AND r.campaign_id=_campaign.id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','receipt_not_found'); END IF;
    IF _receipt.poll_id<>_campaign.poll_id THEN RETURN jsonb_build_object('result_kind','receipt_campaign_mismatch'); END IF;
    IF _receipt.status='paid' THEN RETURN jsonb_build_object('result_kind','receipt_paid'); END IF;
    IF _receipt.status IN ('failed','retryable') THEN RETURN jsonb_build_object('result_kind','receipt_state_conflict','state',_receipt.status); END IF;
    SELECT a.* INTO _attempt FROM public.reward_payout_attempts a WHERE a.receipt_id=_receipt.id ORDER BY a.attempt_number DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      IF _receipt.status='payout_pending' AND _attempt.status='pending' THEN
        SELECT v.vault_address_hex INTO _vault FROM public.reward_campaign_vaults v WHERE v.settlement_id=_root.id;
        RETURN jsonb_build_object('result_kind','replay','attempt_id',_attempt.id,'receipt_id',_receipt.id,'campaign_id',_campaign.id,'settlement_id',_root.id,'attempt_number',_attempt.attempt_number,'attempt_status',_attempt.status,'receipt_status',_receipt.status,'participant_wallet',_receipt.participant_wallet,'amount_luna',_receipt.amount_luna::text,'vault_address_hex',_vault.vault_address_hex,'prepared_transaction_hex',_attempt.prepared_transaction_hex,'transaction_hash',_attempt.transaction_hash,'sender_address_hex',_attempt.sender_address_hex,'recipient_address_hex',_attempt.recipient_address_hex,'fee_luna',_attempt.fee_luna::text,'network_id',_attempt.network_id,'validity_start_height',_attempt.validity_start_height,'prepared_at',_attempt.prepared_at,'broadcast_started_at',_attempt.broadcast_started_at,'broadcast_at',_attempt.broadcast_at);
      END IF;
      RETURN jsonb_build_object('result_kind','payout_state_inconsistent');
    END IF;
    IF _receipt.status<>'reserved' THEN RETURN jsonb_build_object('result_kind','receipt_not_reserved','state',_receipt.status); END IF;
    IF _root.status NOT IN ('rewarding','exhausted') THEN RETURN jsonb_build_object('result_kind','campaign_not_rewarding','state',_root.status); END IF;
    SELECT v.vault_address_hex INTO _vault FROM public.reward_campaign_vaults v WHERE v.settlement_id=_root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','vault_not_found'); END IF;
    SELECT COALESCE(MAX(a.attempt_number),0)+1 INTO _n FROM public.reward_payout_attempts a WHERE a.receipt_id=_receipt.id;
    INSERT INTO public.reward_payout_attempts(receipt_id,attempt_number,status) VALUES(_receipt.id,_n,'pending') RETURNING * INTO _attempt;
    UPDATE public.reward_receipts SET status='payout_pending',updated_at=now() WHERE id=_receipt.id AND status='reserved';
    RETURN jsonb_build_object('result_kind','created','attempt_id',_attempt.id,'receipt_id',_receipt.id,'campaign_id',_campaign.id,'settlement_id',_root.id,'attempt_number',_attempt.attempt_number,'attempt_status',_attempt.status,'receipt_status','payout_pending','participant_wallet',_receipt.participant_wallet,'amount_luna',_receipt.amount_luna::text,'vault_address_hex',_vault.vault_address_hex,'prepared_transaction_hex',NULL,'transaction_hash',NULL,'sender_address_hex',NULL,'recipient_address_hex',NULL,'fee_luna',NULL,'network_id',NULL,'validity_start_height',NULL,'prepared_at',NULL,'broadcast_started_at',NULL,'broadcast_at',NULL);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('result_kind','payout_attempt_conflict');
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_reward_payout_atomic(
    _attempt_id uuid, _sender_address_hex text, _recipient_address_hex text, _amount_luna bigint,
    _fee_luna bigint, _network_id integer, _validity_start_height integer, _transaction_hash text,
    _prepared_transaction_hex text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _attempt record; _hash text:=lower(trim(COALESCE(_transaction_hash,''))); _sender text:=lower(trim(COALESCE(_sender_address_hex,''))); _recipient text:=lower(trim(COALESCE(_recipient_address_hex,''))); _hex text:=lower(trim(COALESCE(_prepared_transaction_hex,'')));
BEGIN
    SELECT a.*,r.campaign_id,r.settlement_id,r.participant_wallet,r.amount_luna AS receipt_amount,r.status AS receipt_status,v.vault_address_hex,s.status AS settlement_status
      INTO _attempt FROM public.reward_payout_attempts a JOIN public.reward_receipts r ON r.id=a.receipt_id JOIN public.reward_settlements s ON s.id=r.settlement_id JOIN public.reward_campaign_vaults v ON v.settlement_id=r.settlement_id WHERE a.id=_attempt_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','attempt_not_found'); END IF;
    IF _attempt.status<>'pending' OR _attempt.receipt_status<>'payout_pending' THEN RETURN jsonb_build_object('result_kind','attempt_state_conflict'); END IF;
    IF _attempt.settlement_status NOT IN ('rewarding','exhausted') THEN RETURN jsonb_build_object('result_kind','campaign_not_rewarding'); END IF;
    IF _attempt.broadcast_started_at IS NOT NULL OR _attempt.broadcast_at IS NOT NULL THEN RETURN jsonb_build_object('result_kind','broadcast_already_started'); END IF;
    IF _attempt.prepared_transaction_hex IS NOT NULL THEN
      IF _attempt.transaction_hash=_hash AND lower(_attempt.sender_address_hex)=_sender AND lower(_attempt.recipient_address_hex)=_recipient AND _attempt.amount_luna=_amount_luna AND _attempt.fee_luna=_fee_luna AND _attempt.network_id=_network_id AND _attempt.validity_start_height=_validity_start_height AND _attempt.prepared_transaction_hex=_hex THEN RETURN jsonb_build_object('result_kind','replay'); END IF;
      RETURN jsonb_build_object('result_kind','prepared_transaction_conflict');
    END IF;
    IF _hash !~ '^[0-9a-f]{64}$' OR _hex !~ '^[0-9a-f]+$' OR length(_hex)=0 OR length(_hex)%2<>0 OR _sender !~ '^[0-9a-f]{40}$' OR _recipient !~ '^[0-9a-f]{40}$' OR _amount_luna IS NULL OR _amount_luna<=0 OR _fee_luna IS NULL OR _fee_luna<0 OR _network_id IS NULL OR _network_id<0 OR _validity_start_height IS NULL OR _validity_start_height<0 THEN RETURN jsonb_build_object('result_kind','prepared_transaction_invalid'); END IF;
    IF _amount_luna<>_attempt.receipt_amount THEN RETURN jsonb_build_object('result_kind','amount_mismatch'); END IF;
    IF _recipient<>lower(trim(_attempt.participant_wallet)) THEN RETURN jsonb_build_object('result_kind','recipient_mismatch'); END IF;
    IF _sender<>lower(_attempt.vault_address_hex) THEN RETURN jsonb_build_object('result_kind','sender_mismatch'); END IF;
    UPDATE public.reward_payout_attempts SET sender_address_hex=_sender,recipient_address_hex=_recipient,amount_luna=_amount_luna,fee_luna=_fee_luna,network_id=_network_id,validity_start_height=_validity_start_height,prepared_transaction_hex=_hex,transaction_hash=_hash,prepared_at=now(),updated_at=now() WHERE id=_attempt_id;
    RETURN jsonb_build_object('result_kind','prepared');
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('result_kind','transaction_hash_conflict');
END;
$$;

CREATE OR REPLACE FUNCTION public.retry_reward_payout_atomic(_receipt_id uuid, _campaign_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _root record; _campaign record; _receipt record; _attempt record; _n integer;
BEGIN
    SELECT * INTO _root FROM public.reward_settlements WHERE id=_campaign_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    SELECT c.* INTO _campaign FROM public.reward_campaigns c JOIN public.settlement_source_bindings b ON b.reward_campaign_id=c.id AND b.source_type='poll_reward_campaign' AND b.settlement_id=_root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    SELECT r.* INTO _receipt FROM public.reward_receipts r WHERE r.id=_receipt_id AND r.settlement_id=_root.id AND r.campaign_id=_campaign.id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','receipt_not_found'); END IF;
    IF _receipt.status='paid' THEN RETURN jsonb_build_object('result_kind','receipt_paid'); END IF;
    IF _receipt.status<>'retryable' THEN RETURN jsonb_build_object('result_kind','payout_state_conflict'); END IF;
    SELECT a.* INTO _attempt FROM public.reward_payout_attempts a WHERE a.receipt_id=_receipt.id ORDER BY a.attempt_number DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND OR _attempt.status<>'retryable' THEN RETURN jsonb_build_object('result_kind','payout_state_conflict'); END IF;
    IF _attempt.transaction_hash IS NOT NULL OR _attempt.broadcast_started_at IS NOT NULL OR _attempt.broadcast_at IS NOT NULL THEN RETURN jsonb_build_object('result_kind','reconciliation_required'); END IF;
    IF _attempt.attempt_number>=5 THEN RETURN jsonb_build_object('result_kind','retry_limit_reached'); END IF;
    _n:=_attempt.attempt_number+1;
    INSERT INTO public.reward_payout_attempts(receipt_id,attempt_number,status) VALUES(_receipt.id,_n,'pending') RETURNING * INTO _attempt;
    UPDATE public.reward_receipts SET status='payout_pending',updated_at=now() WHERE id=_receipt.id AND status='retryable';
    RETURN jsonb_build_object('result_kind','retryable','attempt_id',_attempt.id,'receipt_id',_receipt.id,'campaign_id',_campaign.id,'settlement_id',_root.id,'attempt_number',_attempt.attempt_number,'attempt_status',_attempt.status,'receipt_status','payout_pending','participant_wallet',_receipt.participant_wallet,'amount_luna',_receipt.amount_luna::text);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('result_kind','payout_attempt_conflict');
END;
$$;

CREATE OR REPLACE FUNCTION public.acquire_reward_payout_vault_lock_atomic(_campaign_id uuid, _attempt_id uuid, _lock_token text, _lease_seconds integer DEFAULT 120)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _root record; _attempt_settlement uuid; _lease integer:=GREATEST(30,LEAST(COALESCE(_lease_seconds,120),600));
BEGIN
    SELECT payout_lock_attempt_id,payout_lock_token,payout_lock_expires_at,status INTO _root FROM public.reward_settlements WHERE id=_campaign_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    SELECT r.settlement_id INTO _attempt_settlement FROM public.reward_payout_attempts a JOIN public.reward_receipts r ON r.id=a.receipt_id WHERE a.id=_attempt_id;
    IF NOT FOUND OR _attempt_settlement<>_campaign_id THEN RETURN jsonb_build_object('result_kind','attempt_campaign_mismatch'); END IF;
    IF _lock_token IS NULL OR length(trim(_lock_token))=0 THEN RETURN jsonb_build_object('result_kind','lock_token_invalid'); END IF;
    IF _root.payout_lock_token IS NOT NULL AND _root.payout_lock_token<>_lock_token AND _root.payout_lock_expires_at>now() THEN RETURN jsonb_build_object('result_kind','busy'); END IF;
    UPDATE public.reward_settlements SET payout_lock_attempt_id=_attempt_id,payout_lock_token=_lock_token,payout_lock_expires_at=now()+(_lease||' seconds')::interval,updated_at=now() WHERE id=_campaign_id;
    RETURN jsonb_build_object('result_kind','acquired');
END;
$$;

CREATE OR REPLACE FUNCTION public.release_reward_payout_vault_lock_atomic(_campaign_id uuid, _lock_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    UPDATE public.reward_settlements SET payout_lock_attempt_id=NULL,payout_lock_token=NULL,payout_lock_expires_at=NULL,updated_at=now() WHERE id=_campaign_id AND payout_lock_token=_lock_token;
    RETURN jsonb_build_object('result_kind','released');
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_reward_payout_atomic(
    _attempt_id uuid, _receipt_id uuid, _campaign_id uuid, _transaction_hash text, _network_id integer,
    _observed_sender text, _observed_recipient text, _observed_amount_luna bigint, _execution_result boolean,
    _block_number bigint, _transaction_timestamp timestamptz, _transaction_block_hash text,
    _canonical_block_hash text, _batch_number bigint, _finalizing_macro_block_height bigint,
    _finalizing_macro_block_hash text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _root record; _attempt record; _receipt record; _vault record; _hash text:=lower(trim(COALESCE(_transaction_hash,''))); _sender text:=lower(trim(COALESCE(_observed_sender,''))); _recipient text:=lower(trim(COALESCE(_observed_recipient,''))); _block_hash text:=CASE WHEN _transaction_block_hash IS NULL THEN NULL ELSE lower(trim(_transaction_block_hash)) END; _canonical text:=lower(trim(COALESCE(_canonical_block_hash,''))); _macro text:=lower(trim(COALESCE(_finalizing_macro_block_hash,''))); _at timestamptz;
BEGIN
    IF _hash !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('result_kind','invalid_hash'); END IF;
    IF _network_id IS NULL OR _network_id<0 OR _observed_amount_luna IS NULL OR _observed_amount_luna<=0 OR _execution_result IS DISTINCT FROM true OR _block_number IS NULL OR _block_number<0 OR _canonical !~ '^[0-9a-f]{64}$' OR _batch_number IS NULL OR _batch_number<0 OR _finalizing_macro_block_height IS NULL OR _finalizing_macro_block_height<_block_number OR _macro !~ '^[0-9a-f]{64}$' OR _sender !~ '^[0-9a-f]{40}$' OR _recipient !~ '^[0-9a-f]{40}$' OR (_block_hash IS NOT NULL AND _block_hash !~ '^[0-9a-f]{64}$') THEN RETURN jsonb_build_object('result_kind','invalid_observation'); END IF;
    SELECT * INTO _attempt FROM public.reward_payout_attempts WHERE id=_attempt_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','attempt_not_found'); END IF;
    SELECT * INTO _receipt FROM public.reward_receipts WHERE id=_attempt.receipt_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','receipt_not_found'); END IF;
    SELECT * INTO _root FROM public.reward_settlements WHERE id=_receipt.settlement_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    IF _attempt.receipt_id<>_receipt_id OR _receipt.id<>_receipt_id OR _receipt.settlement_id<>_campaign_id OR _root.id<>_campaign_id THEN RETURN jsonb_build_object('result_kind','attempt_receipt_mismatch'); END IF;
    SELECT v.vault_address_hex INTO _vault FROM public.reward_campaign_vaults v WHERE v.settlement_id=_root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','vault_not_found'); END IF;
    IF _attempt.transaction_hash IS NULL OR lower(trim(_attempt.transaction_hash))<>_hash THEN RETURN jsonb_build_object('result_kind','hash_mismatch'); END IF;
    IF _attempt.network_id IS NULL OR _attempt.network_id<>_network_id THEN RETURN jsonb_build_object('result_kind','wrong_network'); END IF;
    IF lower(trim(_vault.vault_address_hex))<>_sender THEN RETURN jsonb_build_object('result_kind','wrong_sender'); END IF;
    IF lower(trim(_receipt.participant_wallet))<>_recipient THEN RETURN jsonb_build_object('result_kind','wrong_recipient'); END IF;
    IF _receipt.amount_luna<>_observed_amount_luna THEN RETURN jsonb_build_object('result_kind','amount_mismatch'); END IF;
    IF _attempt.status='confirmed' AND _receipt.status='paid' THEN RETURN jsonb_build_object('result_kind','replay','attempt_id',_attempt.id,'receipt_id',_receipt.id,'campaign_id',_campaign_id,'settlement_id',_root.id,'transaction_hash',_attempt.transaction_hash,'confirmed_at',_attempt.confirmed_at,'paid_at',_receipt.paid_at); END IF;
    IF _attempt.status<>'pending' OR _receipt.status<>'payout_pending' THEN RETURN jsonb_build_object('result_kind','payout_state_conflict'); END IF;
    IF _attempt.broadcast_started_at IS NULL THEN RETURN jsonb_build_object('result_kind','broadcast_not_started'); END IF;
    IF _root.paid_amount_luna+_receipt.amount_luna+_root.fee_spent_luna>_root.funded_amount_luna THEN RETURN jsonb_build_object('result_kind','payout_accounting_conflict'); END IF;
    _at:=COALESCE(_attempt.confirmed_at,now());
    UPDATE public.reward_payout_attempts SET status='confirmed',confirmed_at=_at,confirmed_network_id=_network_id,confirmed_block_number=_block_number,confirmed_transaction_timestamp=_transaction_timestamp,confirmed_transaction_block_hash=_block_hash,confirmed_canonical_block_hash=_canonical,confirmed_batch_number=_batch_number,confirmed_finalizing_macro_block_height=_finalizing_macro_block_height,confirmed_finalizing_macro_block_hash=_macro,error_code=NULL,updated_at=_at WHERE id=_attempt.id;
    UPDATE public.reward_receipts SET status='paid',paid_at=COALESCE(paid_at,_at),updated_at=_at WHERE id=_receipt.id;
    UPDATE public.reward_settlements SET paid_amount_luna=paid_amount_luna+_receipt.amount_luna,updated_at=_at WHERE id=_root.id;
    RETURN jsonb_build_object('result_kind','confirmed','attempt_id',_attempt.id,'receipt_id',_receipt.id,'campaign_id',_campaign_id,'settlement_id',_root.id,'transaction_hash',_hash,'amount_luna',_receipt.amount_luna::text,'confirmed_at',_at,'paid_at',_at,'confirmed_block_number',_block_number,'confirmed_canonical_block_hash',_canonical,'confirmed_batch_number',_batch_number,'confirmed_finalizing_macro_block_height',_finalizing_macro_block_height,'confirmed_finalizing_macro_block_hash',_macro);
END;
$$;

-- ==========================================================================
-- Refund preparation, lease, and finality RPCs
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.begin_reward_refund_atomic(_campaign_id uuid, _session_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    _root record; _campaign record; _poll record; _vault record; _refund record; _session_wallet text; _now timestamptz:=now();
    _unresolved_count integer; _unresolved_amount bigint; _recon_count integer; _recon_amount bigint;
    _paid_amount bigint; _invalid_paid integer; _invalid_receipt integer; _confirmed_fee bigint; _missing_fee integer;
    _unused_principal bigint; _unused_fee bigint; _ledger bigint; _safe_balance bigint; _refund_amount bigint;
BEGIN
    IF _session_token_hash IS NULL OR length(trim(_session_token_hash))=0 THEN RETURN jsonb_build_object('result_kind','forbidden'); END IF;
    SELECT wallet_address INTO _session_wallet FROM public.wallet_sessions WHERE token_hash=lower(trim(_session_token_hash)) AND revoked_at IS NULL AND expires_at>_now;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','forbidden'); END IF;
    SELECT * INTO _root FROM public.reward_settlements WHERE id=_campaign_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    SELECT c.* INTO _campaign FROM public.reward_campaigns c JOIN public.settlement_source_bindings b ON b.reward_campaign_id=c.id AND b.source_type='poll_reward_campaign' AND b.settlement_id=_root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    IF lower(trim(_root.owner_wallet))<>lower(trim(_session_wallet)) THEN RETURN jsonb_build_object('result_kind','forbidden'); END IF;
    SELECT r.* INTO _refund FROM public.reward_refunds r WHERE r.settlement_id=_root.id ORDER BY r.created_at ASC,r.id ASC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      IF _root.status='refunding' THEN RETURN jsonb_build_object('result_kind','replay','refund_id',_refund.id,'campaign_id',_campaign.id,'settlement_id',_root.id,'creator_wallet',_refund.creator_wallet,'amount_luna',_refund.amount_luna::text,'status',_refund.status,'transaction_hash',_refund.transaction_hash,'created_at',_refund.created_at); END IF;
      IF _root.status='refunded' THEN RETURN jsonb_build_object('result_kind','already_refunded_or_closed','refund_id',_refund.id,'campaign_id',_campaign.id,'settlement_id',_root.id,'creator_wallet',_refund.creator_wallet,'amount_luna',_refund.amount_luna::text,'status',_refund.status,'transaction_hash',_refund.transaction_hash,'created_at',_refund.created_at); END IF;
      RETURN jsonb_build_object('result_kind','refund_state_conflict','state',_root.status);
    END IF;
    IF _root.status='refunded' THEN RETURN jsonb_build_object('result_kind','already_refunded_or_closed','campaign_id',_campaign.id,'settlement_id',_root.id,'state',_root.status,'amount_luna','0'); END IF;
    IF _root.status='refunding' THEN RETURN jsonb_build_object('result_kind','refund_intent_missing','campaign_id',_campaign.id,'settlement_id',_root.id); END IF;
    SELECT p.creator_wallet,p.status,p.ends_at INTO _poll FROM public.polls p WHERE p.id=_campaign.poll_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','poll_not_found'); END IF;
    IF lower(trim(_root.owner_wallet))<>lower(trim(_poll.creator_wallet)) THEN RETURN jsonb_build_object('result_kind','campaign_owner_mismatch','campaign_id',_campaign.id,'settlement_id',_root.id); END IF;
    SELECT v.vault_address_hex INTO _vault FROM public.reward_campaign_vaults v WHERE v.settlement_id=_root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','vault_not_found'); END IF;
    IF _root.status='cancelled' THEN
      IF _root.first_reservation_at IS NOT NULL THEN RETURN jsonb_build_object('result_kind','campaign_not_closable','campaign_id',_campaign.id,'state',_root.status); END IF;
    ELSIF _root.status IN ('closed','funded','rewarding','exhausted') THEN
      IF NOT (_poll.status='closed' OR (_poll.status='live' AND _poll.ends_at<=_now)) THEN RETURN jsonb_build_object('result_kind','campaign_not_closable','campaign_id',_campaign.id,'state',_root.status); END IF;
    ELSE RETURN jsonb_build_object('result_kind','campaign_not_closable','campaign_id',_campaign.id,'state',_root.status); END IF;

    SELECT COALESCE(count(*) FILTER(WHERE r.status IN ('reserved','payout_pending','retryable')),0)::integer,
           COALESCE(sum(r.amount_luna) FILTER(WHERE r.status IN ('reserved','payout_pending','retryable')),0)::bigint,
           COALESCE(count(*) FILTER(WHERE r.status<>'paid' AND EXISTS(SELECT 1 FROM public.reward_payout_attempts a WHERE a.receipt_id=r.id AND (a.transaction_hash IS NOT NULL OR a.broadcast_started_at IS NOT NULL OR a.broadcast_at IS NOT NULL OR a.status='confirmed' OR lower(COALESCE(a.error_code,'')) LIKE '%unknown%' OR lower(COALESCE(a.error_code,'')) LIKE '%manual%'))),0)::integer,
           COALESCE(sum(r.amount_luna) FILTER(WHERE r.status<>'paid' AND EXISTS(SELECT 1 FROM public.reward_payout_attempts a WHERE a.receipt_id=r.id AND (a.transaction_hash IS NOT NULL OR a.broadcast_started_at IS NOT NULL OR a.broadcast_at IS NOT NULL OR a.status='confirmed' OR lower(COALESCE(a.error_code,'')) LIKE '%unknown%' OR lower(COALESCE(a.error_code,'')) LIKE '%manual%'))),0)::bigint
      INTO _unresolved_count,_unresolved_amount,_recon_count,_recon_amount FROM public.reward_receipts r WHERE r.settlement_id=_root.id;
    SELECT COALESCE(sum(r.amount_luna) FILTER(WHERE r.status='paid'),0)::bigint,
           COALESCE(count(*) FILTER(WHERE r.status='paid' AND r.paid_at IS NULL),0)::integer,
           COALESCE(count(*) FILTER(WHERE r.poll_id IS DISTINCT FROM _campaign.poll_id),0)::integer
      INTO _paid_amount,_invalid_paid,_invalid_receipt FROM public.reward_receipts r WHERE r.settlement_id=_root.id;
    SELECT COALESCE(sum(a.fee_luna) FILTER(WHERE a.status='confirmed'),0)::bigint,
           COALESCE(count(*) FILTER(WHERE a.status='confirmed' AND a.fee_luna IS NULL),0)::integer
      INTO _confirmed_fee,_missing_fee FROM public.reward_payout_attempts a JOIN public.reward_receipts r ON r.id=a.receipt_id WHERE r.settlement_id=_root.id;
    IF _recon_count>0 THEN RETURN jsonb_build_object('result_kind','payout_reconciliation_required','campaign_id',_campaign.id,'settlement_id',_root.id,'unresolved_receipt_count',_unresolved_count,'unresolved_amount_luna',_unresolved_amount::text,'reconciliation_required_receipt_count',_recon_count,'reconciliation_required_amount_luna',_recon_amount::text); END IF;
    IF _unresolved_count>0 THEN RETURN jsonb_build_object('result_kind','unresolved_reward_obligations','campaign_id',_campaign.id,'settlement_id',_root.id,'unresolved_receipt_count',_unresolved_count,'unresolved_amount_luna',_unresolved_amount::text); END IF;
    IF _invalid_receipt>0 OR _invalid_paid>0 OR _missing_fee>0 OR _root.paid_amount_luna<>_paid_amount OR _root.fee_spent_luna<>_confirmed_fee OR _root.funded_amount_luna<0 OR _root.reward_principal_luna<0 OR _root.fee_reserve_luna<0 OR _root.refundable_excess_luna<0 OR _root.paid_amount_luna<0 OR _root.fee_spent_luna<0 OR _root.paid_amount_luna>_root.reward_principal_luna OR _root.fee_spent_luna>_root.fee_reserve_luna OR _root.paid_amount_luna+_root.fee_spent_luna>_root.funded_amount_luna OR _root.funded_amount_luna<>_root.reward_principal_luna+_root.fee_reserve_luna+_root.refundable_excess_luna OR _root.refundable_amount_luna<>0 THEN RETURN jsonb_build_object('result_kind','invalid_reward_accounting','campaign_id',_campaign.id,'settlement_id',_root.id,'amount_luna','0'); END IF;
    _unused_principal:=_root.reward_principal_luna-_root.paid_amount_luna; _unused_fee:=_root.fee_reserve_luna-_root.fee_spent_luna; _ledger:=_unused_principal+_unused_fee+_root.refundable_excess_luna; _safe_balance:=_root.funded_amount_luna-_root.paid_amount_luna-_root.fee_spent_luna; _refund_amount:=LEAST(_ledger,_safe_balance);
    IF _refund_amount<0 THEN RETURN jsonb_build_object('result_kind','invalid_reward_accounting','campaign_id',_campaign.id,'settlement_id',_root.id,'amount_luna','0'); END IF;
    IF _refund_amount=0 THEN
      UPDATE public.reward_settlements SET status='refunded',refundable_amount_luna=0,closed_at=COALESCE(closed_at,_now),refunded_at=COALESCE(refunded_at,_now),updated_at=_now WHERE id=_root.id;
      RETURN jsonb_build_object('result_kind','nothing_to_refund','campaign_id',_campaign.id,'settlement_id',_root.id,'campaign_status','refunded','creator_wallet',_root.refund_recipient_wallet,'vault_address_hex',_vault.vault_address_hex,'amount_luna','0','transaction_hash',NULL);
    END IF;
    INSERT INTO public.reward_refunds(campaign_id,settlement_id,creator_wallet,amount_luna,status) VALUES(_campaign.id,_root.id,_root.refund_recipient_wallet,_refund_amount,'pending') RETURNING * INTO _refund;
    UPDATE public.reward_settlements SET status='refunding',refundable_amount_luna=_refund_amount,closed_at=COALESCE(closed_at,_now),updated_at=_now WHERE id=_root.id;
    RETURN jsonb_build_object('result_kind','created','refund_id',_refund.id,'campaign_id',_campaign.id,'settlement_id',_root.id,'creator_wallet',_root.refund_recipient_wallet,'vault_address_hex',_vault.vault_address_hex,'amount_luna',_refund_amount::text,'status','pending','campaign_status','refunding','unused_reward_principal_luna',_unused_principal::text,'unused_fee_reserve_luna',_unused_fee::text,'refundable_excess_luna',_root.refundable_excess_luna::text,'ledger_refundable_amount_luna',_ledger::text,'transaction_hash',NULL,'created_at',_refund.created_at,'closed_at',_now);
END;
$$;

CREATE OR REPLACE FUNCTION public.acquire_reward_refund_vault_lock_atomic(_campaign_id uuid,_refund_id uuid,_lock_token text,_lease_seconds integer DEFAULT 120)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _root record; _refund_settlement uuid; _lease integer:=GREATEST(30,LEAST(COALESCE(_lease_seconds,120),600));
BEGIN
    SELECT payout_lock_attempt_id,payout_lock_token,payout_lock_expires_at,status INTO _root FROM public.reward_settlements WHERE id=_campaign_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    SELECT settlement_id INTO _refund_settlement FROM public.reward_refunds WHERE id=_refund_id FOR SHARE;
    IF NOT FOUND OR _refund_settlement<>_campaign_id THEN RETURN jsonb_build_object('result_kind','refund_campaign_mismatch'); END IF;
    IF _root.status<>'refunding' THEN RETURN jsonb_build_object('result_kind','campaign_not_refunding'); END IF;
    IF _lock_token IS NULL OR length(trim(_lock_token))=0 THEN RETURN jsonb_build_object('result_kind','lock_token_invalid'); END IF;
    IF _root.payout_lock_token IS NOT NULL AND _root.payout_lock_token<>_lock_token AND _root.payout_lock_expires_at>now() THEN RETURN jsonb_build_object('result_kind','busy'); END IF;
    UPDATE public.reward_settlements SET payout_lock_attempt_id=_refund_id,payout_lock_token=_lock_token,payout_lock_expires_at=now()+(_lease||' seconds')::interval,updated_at=now() WHERE id=_campaign_id;
    RETURN jsonb_build_object('result_kind','acquired');
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_reward_refund_transaction_atomic(
    _refund_id uuid,_sender_address_hex text,_recipient_address_hex text,_amount_luna bigint,_fee_luna bigint,
    _network_id integer,_validity_start_height integer,_prepared_transaction_hash text,_prepared_transaction_hex text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _root record; _refund record; _vault record; _sender text:=lower(trim(COALESCE(_sender_address_hex,''))); _recipient text:=lower(trim(COALESCE(_recipient_address_hex,''))); _hash text:=lower(trim(COALESCE(_prepared_transaction_hash,''))); _hex text:=lower(trim(COALESCE(_prepared_transaction_hex,'')));
BEGIN
    SELECT r.* INTO _refund FROM public.reward_refunds r WHERE r.id=_refund_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','refund_not_found'); END IF;
    SELECT * INTO _root FROM public.reward_settlements WHERE id=_refund.settlement_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    IF _root.status<>'refunding' THEN RETURN jsonb_build_object('result_kind','campaign_not_refunding'); END IF;
    IF _refund.status NOT IN ('pending','retryable') THEN RETURN jsonb_build_object('result_kind','refund_state_conflict','state',_refund.status); END IF;
    IF _refund.transaction_hash IS NOT NULL OR _refund.broadcast_started_at IS NOT NULL THEN RETURN jsonb_build_object('result_kind','broadcast_already_started'); END IF;
    SELECT v.vault_address_hex INTO _vault FROM public.reward_campaign_vaults v WHERE v.settlement_id=_root.id FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','vault_not_found'); END IF;
    IF _root.refundable_amount_luna<>_refund.amount_luna OR _refund.creator_wallet<>_root.refund_recipient_wallet THEN RETURN jsonb_build_object('result_kind','refund_frozen_state_conflict'); END IF;
    IF _amount_luna IS NULL OR _amount_luna<=0 OR _amount_luna<>_refund.amount_luna OR _fee_luna IS NULL OR _fee_luna<0 OR _network_id IS NULL OR _network_id<0 OR _validity_start_height IS NULL OR _validity_start_height<0 OR _sender !~ '^[0-9a-f]{40}$' OR _recipient !~ '^[0-9a-f]{40}$' OR _hash !~ '^[0-9a-f]{64}$' OR _hex !~ '^[0-9a-f]+$' OR length(_hex)=0 OR length(_hex)%2<>0 THEN RETURN jsonb_build_object('result_kind','prepared_transaction_invalid'); END IF;
    IF _sender<>lower(_vault.vault_address_hex) THEN RETURN jsonb_build_object('result_kind','sender_mismatch'); END IF;
    IF _recipient<>lower(_refund.creator_wallet) THEN RETURN jsonb_build_object('result_kind','recipient_mismatch'); END IF;
    IF _refund.prepared_transaction_hash IS NOT NULL THEN
      IF _refund.prepared_transaction_hash=_hash AND _refund.prepared_transaction_hex=_hex AND lower(_refund.sender_address_hex)=_sender AND lower(_refund.recipient_address_hex)=_recipient AND _refund.amount_luna=_amount_luna AND _refund.fee_luna=_fee_luna AND _refund.network_id=_network_id AND _refund.validity_start_height=_validity_start_height THEN UPDATE public.reward_refunds SET status='pending',error_code=NULL,updated_at=now() WHERE id=_refund_id; RETURN jsonb_build_object('result_kind','replay'); END IF;
      RETURN jsonb_build_object('result_kind','prepared_transaction_conflict');
    END IF;
    UPDATE public.reward_refunds SET sender_address_hex=_sender,recipient_address_hex=_recipient,fee_luna=_fee_luna,network_id=_network_id,validity_start_height=_validity_start_height,prepared_transaction_hex=_hex,prepared_transaction_hash=_hash,prepared_at=COALESCE(prepared_at,now()),error_code=NULL,updated_at=now(),status='pending' WHERE id=_refund_id;
    RETURN jsonb_build_object('result_kind','prepared');
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_reward_refund_broadcast_starting_atomic(_refund_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _refund record; _status text;
BEGIN
    SELECT r.*,s.status INTO _refund FROM public.reward_refunds r JOIN public.reward_settlements s ON s.id=r.settlement_id WHERE r.id=_refund_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','refund_not_found'); END IF;
    IF _refund.status<>'pending' OR _refund.prepared_transaction_hash IS NULL OR _refund.prepared_transaction_hex IS NULL THEN RETURN jsonb_build_object('result_kind','refund_not_prepared'); END IF;
    IF _refund.status='pending' AND _refund.broadcast_at IS NOT NULL THEN RETURN jsonb_build_object('result_kind','replay','transaction_hash',_refund.transaction_hash); END IF;
    IF _refund.broadcast_started_at IS NOT NULL THEN RETURN jsonb_build_object('result_kind','already_started'); END IF;
    IF _refund.status<>'pending' OR _refund.settlement_id IS NULL THEN RETURN jsonb_build_object('result_kind','campaign_not_refunding'); END IF;
    SELECT status INTO _status FROM public.reward_settlements WHERE id=_refund.settlement_id;
    IF _status<>'refunding' THEN RETURN jsonb_build_object('result_kind','campaign_not_refunding'); END IF;
    UPDATE public.reward_refunds SET broadcast_started_at=now(),error_code=NULL,updated_at=now() WHERE id=_refund_id;
    RETURN jsonb_build_object('result_kind','started');
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_reward_refund_broadcast_atomic(_refund_id uuid,_transaction_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _refund record; _status text; _hash text:=lower(trim(COALESCE(_transaction_hash,'')));
BEGIN
    SELECT r.*,s.status INTO _refund FROM public.reward_refunds r JOIN public.reward_settlements s ON s.id=r.settlement_id WHERE r.id=_refund_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','refund_not_found'); END IF;
    _status:=_refund.status;
    IF _status<>'pending' THEN RETURN jsonb_build_object('result_kind','campaign_not_refunding'); END IF;
    IF _hash !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('result_kind','invalid_hash'); END IF;
    IF _refund.transaction_hash IS NOT NULL AND _refund.broadcast_at IS NOT NULL THEN IF _refund.transaction_hash=_hash THEN RETURN jsonb_build_object('result_kind','replay','transaction_hash',_hash); END IF; RETURN jsonb_build_object('result_kind','hash_conflict'); END IF;
    IF _refund.broadcast_started_at IS NULL OR _refund.prepared_transaction_hash IS NULL THEN RETURN jsonb_build_object('result_kind','refund_state_conflict'); END IF;
    IF _refund.prepared_transaction_hash<>_hash THEN RETURN jsonb_build_object('result_kind','hash_mismatch'); END IF;
    UPDATE public.reward_refunds SET transaction_hash=_hash,broadcast_at=now(),error_code=NULL,updated_at=now() WHERE id=_refund_id;
    RETURN jsonb_build_object('result_kind','broadcasted','transaction_hash',_hash);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('result_kind','transaction_hash_conflict');
END;
$$;

CREATE OR REPLACE FUNCTION public.record_reward_refund_failure_atomic(_refund_id uuid,_error_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _refund record; _status text;
BEGIN
    SELECT r.*,s.status AS settlement_status INTO _refund FROM public.reward_refunds r JOIN public.reward_settlements s ON s.id=r.settlement_id WHERE r.id=_refund_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','refund_not_found'); END IF;
    IF _refund.settlement_status<>'refunding' THEN RETURN jsonb_build_object('result_kind','campaign_not_refunding'); END IF;
    IF _refund.broadcast_started_at IS NOT NULL OR _refund.broadcast_at IS NOT NULL THEN RETURN jsonb_build_object('result_kind','broadcast_already_started'); END IF;
    IF _refund.status NOT IN ('pending','retryable') THEN RETURN jsonb_build_object('result_kind','refund_state_conflict'); END IF;
    UPDATE public.reward_refunds SET status='retryable',error_code=left(COALESCE(NULLIF(trim(_error_code),''),'refund_prebroadcast_failed'),64),updated_at=now() WHERE id=_refund_id;
    RETURN jsonb_build_object('result_kind','retryable');
END;
$$;

CREATE OR REPLACE FUNCTION public.record_reward_refund_unknown_atomic(_refund_id uuid,_error_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _refund record;
BEGIN
    SELECT r.*,s.status AS settlement_status INTO _refund FROM public.reward_refunds r JOIN public.reward_settlements s ON s.id=r.settlement_id WHERE r.id=_refund_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','refund_not_found'); END IF;
    IF _refund.settlement_status<>'refunding' THEN RETURN jsonb_build_object('result_kind','campaign_not_refunding'); END IF;
    IF _refund.broadcast_at IS NOT NULL THEN RETURN jsonb_build_object('result_kind','replay'); END IF;
    IF _refund.broadcast_started_at IS NULL OR _refund.status<>'pending' THEN RETURN jsonb_build_object('result_kind','refund_state_conflict'); END IF;
    UPDATE public.reward_refunds SET error_code=left(COALESCE(NULLIF(trim(_error_code),''),'refund_broadcast_unknown'),64),updated_at=now() WHERE id=_refund_id;
    RETURN jsonb_build_object('result_kind','unknown');
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_reward_refund_atomic(
    _refund_id uuid,_campaign_id uuid,_transaction_hash text,_network_id integer,_observed_sender text,_observed_recipient text,
    _observed_amount_luna bigint,_execution_result boolean,_block_number bigint,_transaction_timestamp timestamptz,
    _transaction_block_hash text,_canonical_block_hash text,_batch_number bigint,_finalizing_macro_block_height bigint,
    _finalizing_macro_block_hash text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _refund record; _root record; _vault record; _hash text:=lower(trim(COALESCE(_transaction_hash,''))); _sender text:=lower(trim(COALESCE(_observed_sender,''))); _recipient text:=lower(trim(COALESCE(_observed_recipient,''))); _block_hash text:=CASE WHEN _transaction_block_hash IS NULL THEN NULL ELSE lower(trim(_transaction_block_hash)) END; _canonical text:=lower(trim(COALESCE(_canonical_block_hash,''))); _macro text:=lower(trim(COALESCE(_finalizing_macro_block_hash,''))); _at timestamptz;
BEGIN
    IF _hash !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('result_kind','invalid_hash'); END IF;
    IF _network_id IS NULL OR _network_id<0 OR _observed_amount_luna IS NULL OR _observed_amount_luna<=0 OR _execution_result IS DISTINCT FROM true OR _block_number IS NULL OR _block_number<0 OR _canonical !~ '^[0-9a-f]{64}$' OR _batch_number IS NULL OR _batch_number<0 OR _finalizing_macro_block_height IS NULL OR _finalizing_macro_block_height<_block_number OR _macro !~ '^[0-9a-f]{64}$' OR _sender !~ '^[0-9a-f]{40}$' OR _recipient !~ '^[0-9a-f]{40}$' OR (_block_hash IS NOT NULL AND _block_hash !~ '^[0-9a-f]{64}$') THEN RETURN jsonb_build_object('result_kind','invalid_observation'); END IF;
    SELECT * INTO _refund FROM public.reward_refunds WHERE id=_refund_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','refund_not_found'); END IF;
    SELECT * INTO _root FROM public.reward_settlements WHERE id=_refund.settlement_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    IF _refund.settlement_id<>_campaign_id THEN RETURN jsonb_build_object('result_kind','refund_campaign_mismatch'); END IF;
    SELECT v.vault_address_hex INTO _vault FROM public.reward_campaign_vaults v WHERE v.settlement_id=_root.id FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','vault_not_found'); END IF;
    IF _refund.transaction_hash IS NULL OR lower(trim(_refund.transaction_hash))<>_hash THEN RETURN jsonb_build_object('result_kind','hash_mismatch'); END IF;
    IF _refund.network_id IS NULL OR _refund.network_id<>_network_id THEN RETURN jsonb_build_object('result_kind','wrong_network'); END IF;
    IF lower(trim(COALESCE(_refund.sender_address_hex,'')))<>lower(_vault.vault_address_hex) OR _sender<>lower(_vault.vault_address_hex) THEN RETURN jsonb_build_object('result_kind','wrong_sender'); END IF;
    IF lower(trim(COALESCE(_refund.recipient_address_hex,'')))<>lower(_refund.creator_wallet) OR _recipient<>lower(_refund.creator_wallet) THEN RETURN jsonb_build_object('result_kind','wrong_recipient'); END IF;
    IF _refund.amount_luna<>_observed_amount_luna OR _root.refundable_amount_luna<>_refund.amount_luna OR lower(trim(_root.refund_recipient_wallet))<>lower(trim(_refund.creator_wallet)) THEN RETURN jsonb_build_object('result_kind','amount_mismatch'); END IF;
    IF _refund.status='confirmed' AND _root.status='refunded' THEN RETURN jsonb_build_object('result_kind','replay','refund_id',_refund.id,'campaign_id',_campaign_id,'settlement_id',_root.id,'transaction_hash',_refund.transaction_hash,'confirmed_at',_refund.confirmed_at,'refunded_at',_root.refunded_at); END IF;
    IF _root.status<>'refunding' OR _refund.status<>'pending' THEN RETURN jsonb_build_object('result_kind','refund_state_conflict'); END IF;
    IF _refund.broadcast_started_at IS NULL OR _refund.broadcast_at IS NULL THEN RETURN jsonb_build_object('result_kind','broadcast_not_confirmable'); END IF;
    _at:=COALESCE(_refund.confirmed_at,now());
    UPDATE public.reward_refunds SET status='confirmed',block_number=_block_number,transaction_timestamp=_transaction_timestamp,confirmed_at=_at,confirmed_network_id=_network_id,confirmed_transaction_block_hash=_block_hash,confirmed_canonical_block_hash=_canonical,confirmed_batch_number=_batch_number,confirmed_finalizing_macro_block_height=_finalizing_macro_block_height,confirmed_finalizing_macro_block_hash=_macro,error_code=NULL,updated_at=_at WHERE id=_refund.id;
    UPDATE public.reward_settlements SET status='refunded',refunded_at=COALESCE(refunded_at,_at),updated_at=_at WHERE id=_root.id;
    RETURN jsonb_build_object('result_kind','confirmed','refund_id',_refund.id,'campaign_id',_campaign_id,'settlement_id',_root.id,'transaction_hash',_hash,'amount_luna',_refund.amount_luna::text,'confirmed_at',_at,'refunded_at',_at,'block_number',_block_number,'confirmed_canonical_block_hash',_canonical,'confirmed_batch_number',_batch_number,'confirmed_finalizing_macro_block_height',_finalizing_macro_block_height,'confirmed_finalizing_macro_block_hash',_macro);
END;
$$;

-- ==========================================================================
-- Vault identity cutover
-- ==========================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.reward_campaign_vaults
        WHERE settlement_id IS NULL
    ) THEN
        RAISE EXCEPTION 'v2c2e vault cutover blocked: settlement_id is null'
            USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.reward_campaign_vaults
        GROUP BY settlement_id HAVING COUNT(*) <> 1
    ) THEN
        RAISE EXCEPTION 'v2c2e vault cutover blocked: duplicate settlement vault'
            USING ERRCODE = 'unique_violation';
    END IF;
END;
$$;

ALTER TABLE public.reward_campaign_vaults
  DROP CONSTRAINT reward_campaign_vaults_pkey;

ALTER TABLE public.reward_campaign_vaults
  ALTER COLUMN campaign_id DROP NOT NULL,
  ALTER COLUMN settlement_id SET NOT NULL;

ALTER TABLE public.reward_campaign_vaults
  ADD CONSTRAINT reward_campaign_vaults_pkey PRIMARY KEY (settlement_id);

DROP INDEX IF EXISTS public.idx_reward_campaign_vaults_settlement;
CREATE UNIQUE INDEX idx_reward_campaign_vaults_campaign_compat
  ON public.reward_campaign_vaults (campaign_id)
  WHERE campaign_id IS NOT NULL;

-- A Poll compatibility ID is derived from its binding.  A standalone Campaign
-- root has no campaign_id and is allowed to own the same custody table.
CREATE OR REPLACE FUNCTION public.ensure_reward_settlement_vault_atomic(
    _settlement_id        uuid,
    _vault_address_hex    text,
    _envelope_version     text,
    _encryption_algorithm text,
    _ciphertext           text,
    _iv                   text,
    _auth_tag             text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _root record;
    _existing record;
    _campaign_id uuid;
    _lock_key bigint;
BEGIN
    _lock_key := ('x' || substr(replace(_settlement_id::text, '-', ''), 1, 15))::bit(64)::bigint;
    IF _lock_key = 0 THEN _lock_key := 1; END IF;
    PERFORM pg_advisory_xact_lock(_lock_key);

    SELECT * INTO _root
    FROM public.reward_settlements
    WHERE id = _settlement_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'settlement_not_found');
    END IF;
    IF _root.status NOT IN ('configured', 'funding_pending') THEN
        RETURN jsonb_build_object('result_kind', 'settlement_state_invalid', 'state', _root.status);
    END IF;
    IF _vault_address_hex IS NULL OR lower(trim(_vault_address_hex)) !~ '^[0-9a-f]{40}$'
       OR _vault_address_hex <> lower(trim(_vault_address_hex))
       OR _envelope_version <> 'votum:reward-vault:v1'
       OR _encryption_algorithm <> 'aes-256-gcm'
       OR _ciphertext IS NULL OR length(trim(_ciphertext)) = 0
       OR _iv IS NULL OR length(trim(_iv)) = 0
       OR _auth_tag IS NULL OR length(trim(_auth_tag)) = 0 THEN
        RETURN jsonb_build_object('result_kind', 'vault_envelope_invalid');
    END IF;

    SELECT b.reward_campaign_id INTO _campaign_id
    FROM public.settlement_source_bindings b
    WHERE b.settlement_id = _settlement_id
      AND b.source_type = 'poll_reward_campaign';

    SELECT v.* INTO _existing
    FROM public.reward_campaign_vaults v
    WHERE v.settlement_id = _settlement_id;
    IF FOUND THEN
        RETURN jsonb_build_object('result_kind','existing','settlement_id',_settlement_id,
            'campaign_id',_existing.campaign_id,'vault_address_hex',_existing.vault_address_hex);
    END IF;

    INSERT INTO public.reward_campaign_vaults(
        settlement_id,campaign_id,vault_address_hex,envelope_version,encryption_algorithm,
        encrypted_private_key_ciphertext,encryption_iv,authentication_tag
    ) VALUES (
        _settlement_id,_campaign_id,lower(trim(_vault_address_hex)),_envelope_version,_encryption_algorithm,
        _ciphertext,_iv,_auth_tag
    ) RETURNING * INTO _existing;

    RETURN jsonb_build_object('result_kind','created','settlement_id',_settlement_id,
        'campaign_id',_existing.campaign_id,'vault_address_hex',_existing.vault_address_hex);
EXCEPTION WHEN unique_violation THEN
    SELECT v.* INTO _existing FROM public.reward_campaign_vaults v WHERE v.settlement_id=_settlement_id;
    IF FOUND THEN
        RETURN jsonb_build_object('result_kind','existing','settlement_id',_settlement_id,
            'campaign_id',_existing.campaign_id,'vault_address_hex',_existing.vault_address_hex);
    END IF;
    RAISE;
END;
$$;

DROP FUNCTION IF EXISTS public.ensure_reward_campaign_vault_atomic(uuid, text, text, text, text, text, text);

-- A null Poll compatibility ID is valid only for a future standalone Campaign
-- settlement. Poll-rooted vaults must retain the exact adapter compatibility ID.
CREATE OR REPLACE FUNCTION public.validate_reward_settlement_child_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign_settlement uuid;
    _binding_settlement uuid;
BEGIN
    IF NEW.settlement_id IS NULL THEN
        RAISE EXCEPTION 'settlement child requires a settlement root'
            USING ERRCODE = 'not_null_violation';
    END IF;

    IF NEW.campaign_id IS NULL THEN
        IF EXISTS (
            SELECT 1
            FROM public.settlement_source_bindings b
            WHERE b.settlement_id = NEW.settlement_id
              AND b.source_type = 'poll_reward_campaign'
        ) THEN
            RAISE EXCEPTION 'Poll settlement vault requires campaign compatibility ID'
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        RETURN NEW;
    END IF;

    SELECT c.settlement_id
    INTO _campaign_settlement
    FROM public.reward_campaigns c
    WHERE c.id = NEW.campaign_id;

    IF NOT FOUND OR _campaign_settlement IS NULL THEN
        RAISE EXCEPTION 'settlement child campaign/root mismatch'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF _campaign_settlement IS DISTINCT FROM NEW.settlement_id THEN
        RAISE EXCEPTION 'settlement child campaign/root mismatch'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT b.settlement_id
    INTO _binding_settlement
    FROM public.settlement_source_bindings b
    WHERE b.reward_campaign_id = NEW.campaign_id
      AND b.source_type = 'poll_reward_campaign';

    IF NOT FOUND OR _binding_settlement IS DISTINCT FROM NEW.settlement_id THEN
        RAISE EXCEPTION 'settlement child Poll binding mismatch'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END;
$$;

-- Atomic Poll offer creation/update used by publication and reward-config
-- routes.  This keeps a new Poll root, adapter row, and source binding in one
-- transaction and never exposes a caller-selected settlement ID.
CREATE OR REPLACE FUNCTION public.ensure_poll_reward_settlement_atomic(
    _poll_id uuid,
    _creator_wallet text,
    _funding_mode text,
    _funding_wallet text,
    _reward_per_participant_luna bigint,
    _max_rewarded_participants integer,
    _reward_principal_luna bigint,
    _fee_reserve_luna bigint,
    _total_budget_luna bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _poll record;
    _campaign record;
    _root record;
    _campaign_id uuid;
    _settlement_id uuid;
    _created boolean := false;
BEGIN
    SELECT p.id, p.creator_wallet
    INTO _poll
    FROM public.polls p
    WHERE p.id = _poll_id
    FOR UPDATE;
    IF NOT FOUND OR lower(trim(_poll.creator_wallet)) <> lower(trim(_creator_wallet)) THEN
        RETURN jsonb_build_object('result_kind', 'forbidden');
    END IF;

    SELECT c.*
    INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.poll_id = _poll_id
    FOR UPDATE;

    IF FOUND THEN
        _campaign_id := _campaign.id;
        _settlement_id := _campaign.settlement_id;
        SELECT * INTO _root
        FROM public.reward_settlements
        WHERE id = _settlement_id
        FOR UPDATE;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('result_kind', 'settlement_not_found');
        END IF;
        IF _root.status <> 'configured' OR _root.first_reservation_at IS NOT NULL THEN
            RETURN jsonb_build_object('result_kind', 'terms_locked', 'campaign_id', _campaign_id, 'settlement_id', _settlement_id, 'status', _root.status);
        END IF;

        UPDATE public.reward_settlements
        SET funding_mode = _funding_mode,
            funding_wallet = lower(trim(_funding_wallet)),
            refund_recipient_wallet = _root.owner_wallet,
            reward_per_participant_luna = _reward_per_participant_luna,
            max_rewarded_participants = _max_rewarded_participants,
            reward_principal_luna = _reward_principal_luna,
            fee_reserve_luna = _fee_reserve_luna,
            total_budget_luna = _total_budget_luna,
            updated_at = now()
        WHERE id = _settlement_id;
    ELSE
        _created := true;
        _campaign_id := gen_random_uuid();
        _settlement_id := gen_random_uuid();
        INSERT INTO public.reward_settlements (
            id, owner_wallet, funding_wallet, refund_recipient_wallet,
            funding_mode, asset, reward_per_participant_luna,
            max_rewarded_participants, reward_principal_luna, fee_reserve_luna,
            total_budget_luna, status
        ) VALUES (
            _settlement_id, lower(trim(_creator_wallet)), lower(trim(_funding_wallet)),
            lower(trim(_creator_wallet)), _funding_mode, 'NIM',
            _reward_per_participant_luna, _max_rewarded_participants,
            _reward_principal_luna, _fee_reserve_luna, _total_budget_luna,
            'configured'
        );
        INSERT INTO public.reward_campaigns (
            id, poll_id, creator_wallet, funding_mode, funding_wallet,
            reward_per_participant_luna, max_rewarded_participants,
            reward_principal_luna, fee_reserve_luna, total_budget_luna,
            status, settlement_id
        ) VALUES (
            _campaign_id, _poll_id, lower(trim(_creator_wallet)), _funding_mode,
            lower(trim(_funding_wallet)), _reward_per_participant_luna,
            _max_rewarded_participants, _reward_principal_luna,
            _fee_reserve_luna, _total_budget_luna, 'configured', _settlement_id
        );
        INSERT INTO public.settlement_source_bindings (
            settlement_id, source_type, reward_campaign_id
        ) VALUES (_settlement_id, 'poll_reward_campaign', _campaign_id);
    END IF;

    RETURN jsonb_build_object(
        'result_kind', CASE WHEN _created THEN 'created' ELSE 'updated' END,
        'campaign_id', _campaign_id,
        'settlement_id', _settlement_id,
        'status', 'configured'
    );
END;
$$;

-- Service-role boundaries only.  Explicitly revoke inherited/default grants so
-- a future role change cannot make financial mutation or vault custody public.
REVOKE EXECUTE ON FUNCTION public.begin_reward_funding_atomic(uuid,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bind_reward_funding_transaction_atomic(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.confirm_reward_funding_atomic(uuid,uuid,text,bigint,bigint,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_reward_receipt_atomic(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.begin_reward_payout_atomic(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prepare_reward_payout_atomic(uuid,text,text,bigint,bigint,integer,integer,text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.retry_reward_payout_atomic(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.acquire_reward_payout_vault_lock_atomic(uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.confirm_reward_payout_atomic(uuid,uuid,uuid,text,integer,text,text,bigint,boolean,bigint,timestamptz,text,text,bigint,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_reward_payout_vault_lock_atomic(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.begin_reward_refund_atomic(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prepare_reward_refund_transaction_atomic(uuid,text,text,bigint,bigint,integer,integer,text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.confirm_reward_refund_atomic(uuid,uuid,text,integer,text,text,bigint,boolean,bigint,timestamptz,text,text,bigint,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.acquire_reward_refund_vault_lock_atomic(uuid,uuid,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_reward_refund_broadcast_starting_atomic(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_reward_refund_broadcast_atomic(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_reward_refund_failure_atomic(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_reward_refund_unknown_atomic(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ensure_reward_settlement_vault_atomic(uuid,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ensure_poll_reward_settlement_atomic(uuid,text,text,text,bigint,integer,bigint,bigint,bigint) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.begin_reward_funding_atomic(uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_reward_funding_transaction_atomic(uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_reward_funding_atomic(uuid,uuid,text,bigint,bigint,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_reward_receipt_atomic(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_reward_payout_atomic(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_reward_payout_atomic(uuid,text,text,bigint,bigint,integer,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.retry_reward_payout_atomic(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.acquire_reward_payout_vault_lock_atomic(uuid,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_reward_payout_atomic(uuid,uuid,uuid,text,integer,text,text,bigint,boolean,bigint,timestamptz,text,text,bigint,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_reward_payout_vault_lock_atomic(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_reward_refund_atomic(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_reward_refund_transaction_atomic(uuid,text,text,bigint,bigint,integer,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_reward_refund_atomic(uuid,uuid,text,integer,text,text,bigint,boolean,bigint,timestamptz,text,text,bigint,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.acquire_reward_refund_vault_lock_atomic(uuid,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_reward_refund_broadcast_starting_atomic(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_reward_refund_broadcast_atomic(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_reward_refund_failure_atomic(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_reward_refund_unknown_atomic(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ensure_reward_settlement_vault_atomic(uuid,text,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ensure_poll_reward_settlement_atomic(uuid,text,text,text,bigint,integer,bigint,bigint,bigint) TO service_role;

COMMIT;
