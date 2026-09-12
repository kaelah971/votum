-- V2B.2.11 Phase B — atomically prepare and freeze one reward refund.
--
-- This boundary creates no transaction and does not touch vault key material.
-- It derives the creator, vault, obligations, and integer-Luna remainder from
-- durable local database state, then freezes the result before Phase C.

-- A campaign has one durable refund intent for its entire lifecycle. The
-- existing partial index protects active rows; this index also protects failed
-- and retryable rows from becoming a second preparation intent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_refunds_campaign_once
  ON public.reward_refunds (campaign_id);

-- ==========================================================================
-- Economic freeze backstops
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.prevent_reward_campaign_refund_freeze()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Closed campaigns may enter refunding only with the pending intent that
    -- the preparation RPC just created. A positive refund may enter refunded
    -- only after a confirmed refund proof exists. A zero remainder may move
    -- directly from closed to refunded without fabricating a refund row.
    IF OLD.status = 'closed' AND NEW.status NOT IN ('closed', 'refunding', 'refunded') THEN
        RAISE EXCEPTION 'closed campaign cannot be reopened'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'closed' AND NEW.status = 'refunding' AND NOT EXISTS (
        SELECT 1
        FROM public.reward_refunds r
        WHERE r.campaign_id = NEW.id
          AND r.status = 'pending'
          AND r.amount_luna = NEW.refundable_amount_luna
    ) THEN
        RAISE EXCEPTION 'refunding campaign requires a pending refund intent'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'closed' AND NEW.status = 'refunded' AND (
        NEW.refundable_amount_luna <> 0
        OR NEW.refunded_at IS NULL
        OR EXISTS (SELECT 1 FROM public.reward_refunds r WHERE r.campaign_id = NEW.id)
    ) THEN
        RAISE EXCEPTION 'closed campaign requires a zero remainder for direct refund closure'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'refunding' AND NEW.status NOT IN ('refunding', 'refunded') THEN
        RAISE EXCEPTION 'refunding campaign cannot be reopened'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'refunded' AND NEW.status <> 'refunded' THEN
        RAISE EXCEPTION 'refunded campaign cannot be reopened'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'refunding' AND NEW.status = 'refunded' AND NOT EXISTS (
        SELECT 1
        FROM public.reward_refunds r
        WHERE r.campaign_id = NEW.id
          AND r.status = 'confirmed'
          AND r.transaction_hash IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'refunded campaign requires a confirmed refund proof'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Economic terms are immutable once the campaign is closed/refunding.
    -- `refundable_amount_luna` is allowed its one-time 0 -> positive freeze on
    -- closed -> refunding; all other terms remain unchanged.
    IF OLD.status IN ('closed', 'refunding', 'refunded') AND (
        NEW.poll_id IS DISTINCT FROM OLD.poll_id OR
        NEW.creator_wallet IS DISTINCT FROM OLD.creator_wallet OR
        NEW.funding_mode IS DISTINCT FROM OLD.funding_mode OR
        NEW.funding_wallet IS DISTINCT FROM OLD.funding_wallet OR
        NEW.reward_per_participant_luna IS DISTINCT FROM OLD.reward_per_participant_luna OR
        NEW.max_rewarded_participants IS DISTINCT FROM OLD.max_rewarded_participants OR
        NEW.reward_principal_luna IS DISTINCT FROM OLD.reward_principal_luna OR
        NEW.fee_reserve_luna IS DISTINCT FROM OLD.fee_reserve_luna OR
        NEW.total_budget_luna IS DISTINCT FROM OLD.total_budget_luna OR
        NEW.asset IS DISTINCT FROM OLD.asset OR
        NEW.funded_amount_luna IS DISTINCT FROM OLD.funded_amount_luna OR
        NEW.refundable_excess_luna IS DISTINCT FROM OLD.refundable_excess_luna OR
        NEW.rewarded_participant_count IS DISTINCT FROM OLD.rewarded_participant_count OR
        NEW.paid_amount_luna IS DISTINCT FROM OLD.paid_amount_luna OR
        NEW.fee_spent_luna IS DISTINCT FROM OLD.fee_spent_luna OR
        (
            NOT (OLD.status = 'closed' AND NEW.status = 'refunding')
            AND NEW.refundable_amount_luna IS DISTINCT FROM OLD.refundable_amount_luna
        ) OR
        NEW.first_reservation_at IS DISTINCT FROM OLD.first_reservation_at OR
        NEW.vault_wallet IS DISTINCT FROM OLD.vault_wallet OR
        NEW.vault_key_ref IS DISTINCT FROM OLD.vault_key_ref
    ) THEN
        RAISE EXCEPTION 'campaign economics are frozen after refund preparation'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reward_campaign_refund_freeze_guard
  ON public.reward_campaigns;

CREATE TRIGGER reward_campaign_refund_freeze_guard
  BEFORE UPDATE ON public.reward_campaigns
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_reward_campaign_refund_freeze();

CREATE OR REPLACE FUNCTION public.prevent_reward_receipt_after_refund_freeze()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign_id uuid;
    _campaign_status text;
BEGIN
    _campaign_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.campaign_id ELSE NEW.campaign_id END;

    SELECT c.status INTO _campaign_status
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;

    IF _campaign_status IN ('closed', 'refunding', 'refunded') THEN
        RAISE EXCEPTION 'reward obligations are blocked after refund preparation'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.campaign_id IS DISTINCT FROM OLD.campaign_id THEN
        SELECT c.status INTO _campaign_status
        FROM public.reward_campaigns c
        WHERE c.id = OLD.campaign_id
        FOR UPDATE;
        IF _campaign_status IN ('closed', 'refunding', 'refunded') THEN
            RAISE EXCEPTION 'reward obligations are blocked after refund preparation'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reward_receipt_refund_freeze_guard
  ON public.reward_receipts;

CREATE TRIGGER reward_receipt_refund_freeze_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.reward_receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_reward_receipt_after_refund_freeze();

CREATE OR REPLACE FUNCTION public.prevent_reward_payout_after_refund_freeze()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _receipt_id uuid;
    _campaign_status text;
BEGIN
    _receipt_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.receipt_id ELSE NEW.receipt_id END;

    SELECT c.status INTO _campaign_status
    FROM public.reward_receipts r
    JOIN public.reward_campaigns c ON c.id = r.campaign_id
    WHERE r.id = _receipt_id
    FOR UPDATE OF c;

    IF _campaign_status IN ('closed', 'refunding', 'refunded') THEN
        RAISE EXCEPTION 'payout obligations are blocked after refund preparation'
            USING ERRCODE = 'check_violation';
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id THEN
        SELECT c.status INTO _campaign_status
        FROM public.reward_receipts r
        JOIN public.reward_campaigns c ON c.id = r.campaign_id
        WHERE r.id = OLD.receipt_id
        FOR UPDATE OF c;
        IF _campaign_status IN ('closed', 'refunding', 'refunded') THEN
            RAISE EXCEPTION 'payout obligations are blocked after refund preparation'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reward_payout_refund_freeze_guard
  ON public.reward_payout_attempts;

CREATE TRIGGER reward_payout_refund_freeze_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.reward_payout_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_reward_payout_after_refund_freeze();

-- Confirmed payout fees are part of the campaign ledger. The existing payout
-- confirmation RPC persists fee_luna on the attempt but historically did not
-- increment fee_spent_luna, so this transition closes that accounting gap.
CREATE OR REPLACE FUNCTION public.account_reward_payout_fee()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign_id uuid;
    _was_confirmed boolean;
BEGIN
    _was_confirmed := CASE
        WHEN TG_OP = 'INSERT' THEN false
        ELSE OLD.status = 'confirmed'
    END;

    IF NOT _was_confirmed AND NEW.status = 'confirmed' THEN
        IF NEW.fee_luna IS NULL OR NEW.fee_luna < 0 THEN
            RAISE EXCEPTION 'confirmed payout requires a non-negative fee'
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT r.campaign_id INTO _campaign_id
        FROM public.reward_receipts r
        WHERE r.id = NEW.receipt_id;

        IF _campaign_id IS NULL THEN
            RAISE EXCEPTION 'confirmed payout receipt not found'
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        UPDATE public.reward_campaigns
        SET fee_spent_luna = fee_spent_luna + NEW.fee_luna,
            updated_at = now()
        WHERE id = _campaign_id;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reward_payout_fee_accounting
  ON public.reward_payout_attempts;

CREATE TRIGGER reward_payout_fee_accounting
  AFTER INSERT OR UPDATE OF status ON public.reward_payout_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.account_reward_payout_fee();

-- Refund hashes are bound later by Phase C, but the same cross-ledger hash
-- uniqueness rule must protect this ledger when that happens.
CREATE OR REPLACE FUNCTION public.prevent_reward_refund_hash_reuse()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _hash text;
    _lock_key bigint;
BEGIN
    IF NEW.transaction_hash IS NULL THEN
        RETURN NEW;
    END IF;

    _hash := lower(trim(NEW.transaction_hash));
    IF _hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'invalid refund transaction hash'
            USING ERRCODE = 'check_violation';
    END IF;

    _lock_key := ('x' || substr(_hash, 1, 15))::bit(64)::bigint;
    IF _lock_key = 0 THEN _lock_key := 1; END IF;
    PERFORM pg_advisory_xact_lock(_lock_key);

    IF EXISTS (
        SELECT 1 FROM public.reward_funding_transactions f
        WHERE lower(COALESCE(f.submitted_transaction_hash, '')) = _hash
           OR lower(COALESCE(f.confirmed_transaction_hash, '')) = _hash
    ) OR EXISTS (
        SELECT 1 FROM public.reward_payout_attempts p
        WHERE lower(COALESCE(p.transaction_hash, '')) = _hash
    ) OR EXISTS (
        SELECT 1 FROM public.nim_support_intents s
        WHERE lower(COALESCE(s.submitted_transaction_hash, '')) = _hash
    ) OR EXISTS (
        SELECT 1 FROM public.nim_contributions c
        WHERE lower(COALESCE(c.transaction_hash, '')) = _hash
    ) OR EXISTS (
        SELECT 1 FROM public.reward_refunds r
        WHERE r.transaction_hash IS NOT NULL
          AND lower(r.transaction_hash) = _hash
          AND r.id <> NEW.id
    ) THEN
        RAISE EXCEPTION 'transaction hash already belongs to another financial record'
            USING ERRCODE = 'unique_violation';
    END IF;

    NEW.transaction_hash := _hash;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reward_refund_hash_reuse_guard
  ON public.reward_refunds;

CREATE TRIGGER reward_refund_hash_reuse_guard
  BEFORE INSERT OR UPDATE OF transaction_hash
  ON public.reward_refunds
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_reward_refund_hash_reuse();

CREATE OR REPLACE FUNCTION public.prevent_reward_refund_economic_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'refund intent cannot be deleted after preparation'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
       OR NEW.creator_wallet IS DISTINCT FROM OLD.creator_wallet
       OR NEW.amount_luna IS DISTINCT FROM OLD.amount_luna
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'frozen refund economics cannot change'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reward_refund_economic_freeze_guard
  ON public.reward_refunds;

CREATE TRIGGER reward_refund_economic_freeze_guard
  BEFORE UPDATE OR DELETE ON public.reward_refunds
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_reward_refund_economic_mutation();

-- ==========================================================================
-- Atomic refund preparation
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.begin_reward_refund_atomic(
    _campaign_id         uuid,
    _session_token_hash  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign record;
    _poll record;
    _vault record;
    _refund record;
    _session_wallet text;
    _now timestamptz := now();
    _unresolved_count integer;
    _unresolved_amount bigint;
    _reconciliation_count integer;
    _reconciliation_amount bigint;
    _paid_receipt_amount bigint;
    _invalid_receipt_count integer;
    _invalid_paid_receipt_count integer;
    _confirmed_fee_amount bigint;
    _missing_confirmed_fee_count integer;
    _unused_principal bigint;
    _unused_fee bigint;
    _ledger_amount bigint;
    _safe_campaign_balance bigint;
    _refund_amount bigint;
BEGIN
    -- The RPC accepts a persisted session identifier, not a caller-supplied
    -- wallet. The HTTP boundary hashes the verified session cookie and passes
    -- that identifier here; this check keeps direct service calls creator-gated
    -- as well.
    IF _session_token_hash IS NULL OR length(trim(_session_token_hash)) = 0 THEN
        RETURN jsonb_build_object('result_kind', 'forbidden');
    END IF;

    SELECT s.wallet_address INTO _session_wallet
    FROM public.wallet_sessions s
    WHERE s.token_hash = lower(trim(_session_token_hash))
      AND s.revoked_at IS NULL
      AND s.expires_at > _now;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'forbidden');
    END IF;

    -- The campaign row is the shared lock boundary for reservation, payout,
    -- confirmation, and refund preparation. Every financial writer must obtain
    -- this lock before it can commit a campaign economic mutation.
    SELECT c.* INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;

    IF lower(trim(_campaign.creator_wallet)) <> lower(trim(_session_wallet)) THEN
        RETURN jsonb_build_object('result_kind', 'forbidden');
    END IF;

    -- A prior row is the durable idempotency record. Lock it without changing
    -- its amount, destination, or created_at freeze timestamp.
    SELECT r.* INTO _refund
    FROM public.reward_refunds r
    WHERE r.campaign_id = _campaign_id
    ORDER BY r.created_at ASC, r.id ASC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
        IF _campaign.status = 'refunding' THEN
            RETURN jsonb_build_object(
                'result_kind', 'replay',
                'refund_id', _refund.id,
                'campaign_id', _campaign.id,
                'creator_wallet', _refund.creator_wallet,
                'amount_luna', _refund.amount_luna::text,
                'status', _refund.status,
                'transaction_hash', _refund.transaction_hash,
                'created_at', _refund.created_at
            );
        END IF;

        IF _campaign.status = 'refunded' THEN
            RETURN jsonb_build_object(
                'result_kind', 'already_refunded_or_closed',
                'refund_id', _refund.id,
                'campaign_id', _campaign.id,
                'creator_wallet', _refund.creator_wallet,
                'amount_luna', _refund.amount_luna::text,
                'status', _refund.status,
                'transaction_hash', _refund.transaction_hash,
                'created_at', _refund.created_at
            );
        END IF;

        RETURN jsonb_build_object(
            'result_kind', 'refund_state_conflict',
            'state', _campaign.status
        );
    END IF;

    IF _campaign.status = 'refunded' THEN
        RETURN jsonb_build_object(
            'result_kind', 'already_refunded_or_closed',
            'campaign_id', _campaign.id,
            'state', _campaign.status,
            'amount_luna', '0'
        );
    END IF;

    IF _campaign.status = 'refunding' THEN
        RETURN jsonb_build_object(
            'result_kind', 'refund_intent_missing',
            'campaign_id', _campaign.id
        );
    END IF;

    -- Derive the campaign owner from the immutable campaign/poll relationship;
    -- never accept a caller-supplied destination. A mismatch is malformed
    -- authority and must not produce a refund intent.
    SELECT p.creator_wallet, p.status, p.ends_at
    INTO _poll
    FROM public.polls p
    WHERE p.id = _campaign.poll_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'poll_not_found');
    END IF;

    IF lower(trim(_campaign.creator_wallet)) <> lower(trim(_poll.creator_wallet)) THEN
        RETURN jsonb_build_object(
            'result_kind', 'campaign_owner_mismatch',
            'campaign_id', _campaign.id
        );
    END IF;

    -- Vault identity is read from the dedicated vault table. The campaign's
    -- nullable snapshot is not used as the authoritative refund source.
    SELECT v.vault_address_hex
    INTO _vault
    FROM public.reward_campaign_vaults v
    WHERE v.campaign_id = _campaign.id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'vault_not_found');
    END IF;

    IF _campaign.status = 'cancelled' THEN
        IF _campaign.first_reservation_at IS NOT NULL THEN
            RETURN jsonb_build_object(
                'result_kind', 'campaign_not_closable',
                'campaign_id', _campaign.id,
                'state', _campaign.status
            );
        END IF;
    ELSIF _campaign.status IN ('closed', 'funded', 'rewarding', 'exhausted') THEN
        IF NOT (
            _poll.status = 'closed'
            OR (_poll.status = 'live' AND _poll.ends_at <= _now)
        ) THEN
            RETURN jsonb_build_object(
                'result_kind', 'campaign_not_closable',
                'campaign_id', _campaign.id,
                'state', _campaign.status
            );
        END IF;
    ELSE
        RETURN jsonb_build_object(
            'result_kind', 'campaign_not_closable',
            'campaign_id', _campaign.id,
            'state', _campaign.status
        );
    END IF;

    -- Review all receipts after taking the campaign lock. We intentionally do
    -- not take receipt row locks here: payout writers may lock receipt first,
    -- then campaign. Their uncommitted obligation remains visible as unresolved
    -- to this statement, while the campaign lock prevents a post-freeze commit.
    SELECT
        COALESCE(count(*) FILTER (WHERE r.status IN ('reserved', 'payout_pending', 'retryable')), 0)::integer,
        COALESCE(sum(r.amount_luna) FILTER (WHERE r.status IN ('reserved', 'payout_pending', 'retryable')), 0)::bigint,
        COALESCE(count(*) FILTER (
            WHERE r.status <> 'paid'
              AND EXISTS (
                  SELECT 1
                  FROM public.reward_payout_attempts a
                  WHERE a.receipt_id = r.id
                    AND (
                        a.transaction_hash IS NOT NULL
                        OR a.broadcast_started_at IS NOT NULL
                        OR a.broadcast_at IS NOT NULL
                        OR a.status = 'confirmed'
                        OR lower(COALESCE(a.error_code, '')) LIKE '%unknown%'
                        OR lower(COALESCE(a.error_code, '')) LIKE '%manual%'
                    )
              )
        ), 0)::integer,
        COALESCE(sum(r.amount_luna) FILTER (
            WHERE r.status <> 'paid'
              AND EXISTS (
                  SELECT 1
                  FROM public.reward_payout_attempts a
                  WHERE a.receipt_id = r.id
                    AND (
                        a.transaction_hash IS NOT NULL
                        OR a.broadcast_started_at IS NOT NULL
                        OR a.broadcast_at IS NOT NULL
                        OR a.status = 'confirmed'
                        OR lower(COALESCE(a.error_code, '')) LIKE '%unknown%'
                        OR lower(COALESCE(a.error_code, '')) LIKE '%manual%'
                    )
              )
        ), 0)::bigint
    INTO _unresolved_count, _unresolved_amount,
         _reconciliation_count, _reconciliation_amount
    FROM public.reward_receipts r
    WHERE r.campaign_id = _campaign.id;

    SELECT
        COALESCE(sum(r.amount_luna) FILTER (WHERE r.status = 'paid'), 0)::bigint,
        COALESCE(count(*) FILTER (WHERE r.status = 'paid' AND r.paid_at IS NULL), 0)::integer,
        COALESCE(count(*) FILTER (WHERE r.poll_id IS DISTINCT FROM _campaign.poll_id), 0)::integer
    INTO _paid_receipt_amount, _invalid_paid_receipt_count, _invalid_receipt_count
    FROM public.reward_receipts r
    WHERE r.campaign_id = _campaign.id;

    SELECT
        COALESCE(sum(a.fee_luna) FILTER (WHERE a.status = 'confirmed'), 0)::bigint,
        COALESCE(count(*) FILTER (WHERE a.status = 'confirmed' AND a.fee_luna IS NULL), 0)::integer
    INTO _confirmed_fee_amount, _missing_confirmed_fee_count
    FROM public.reward_payout_attempts a
    JOIN public.reward_receipts r ON r.id = a.receipt_id
    WHERE r.campaign_id = _campaign.id;

    IF _reconciliation_count > 0 THEN
        RETURN jsonb_build_object(
            'result_kind', 'payout_reconciliation_required',
            'campaign_id', _campaign.id,
            'unresolved_receipt_count', _unresolved_count,
            'unresolved_amount_luna', _unresolved_amount::text,
            'reconciliation_required_receipt_count', _reconciliation_count,
            'reconciliation_required_amount_luna', _reconciliation_amount::text
        );
    END IF;

    IF _unresolved_count > 0 THEN
        RETURN jsonb_build_object(
            'result_kind', 'unresolved_reward_obligations',
            'campaign_id', _campaign.id,
            'unresolved_receipt_count', _unresolved_count,
            'unresolved_amount_luna', _unresolved_amount::text
        );
    END IF;

    -- Validate the same exact accounting relationship as Phase A. The safe
    -- campaign residual is the confirmed funding ledger less confirmed spends;
    -- no unobserved on-chain balance is invented in this no-chain phase.
    IF _invalid_receipt_count > 0
       OR _invalid_paid_receipt_count > 0
       OR _missing_confirmed_fee_count > 0
       OR _campaign.paid_amount_luna <> _paid_receipt_amount
       OR _campaign.fee_spent_luna <> _confirmed_fee_amount
       OR _campaign.funded_amount_luna < 0
       OR _campaign.reward_principal_luna < 0
       OR _campaign.fee_reserve_luna < 0
       OR _campaign.refundable_excess_luna < 0
       OR _campaign.paid_amount_luna < 0
       OR _campaign.fee_spent_luna < 0
       OR _campaign.paid_amount_luna > _campaign.reward_principal_luna
       OR _campaign.fee_spent_luna > _campaign.fee_reserve_luna
       OR _campaign.paid_amount_luna + _campaign.fee_spent_luna > _campaign.funded_amount_luna
       OR _campaign.funded_amount_luna <>
          _campaign.reward_principal_luna +
          _campaign.fee_reserve_luna +
          _campaign.refundable_excess_luna
       OR _campaign.refundable_amount_luna <> 0 THEN
        RETURN jsonb_build_object(
            'result_kind', 'invalid_reward_accounting',
            'campaign_id', _campaign.id,
            'amount_luna', '0'
        );
    END IF;

    _unused_principal := _campaign.reward_principal_luna - _campaign.paid_amount_luna;
    _unused_fee := _campaign.fee_reserve_luna - _campaign.fee_spent_luna;
    _ledger_amount := _unused_principal + _unused_fee + _campaign.refundable_excess_luna;
    _safe_campaign_balance := _campaign.funded_amount_luna -
        _campaign.paid_amount_luna - _campaign.fee_spent_luna;
    _refund_amount := LEAST(_ledger_amount, _safe_campaign_balance);

    IF _refund_amount < 0 THEN
        RETURN jsonb_build_object(
            'result_kind', 'invalid_reward_accounting',
            'campaign_id', _campaign.id,
            'amount_luna', '0'
        );
    END IF;

    -- `reward_refunds.amount_luna` is strictly positive by the existing schema.
    -- A zero remainder reaches the documented refunded terminal state without
    -- fabricating a refund transaction.
    IF _refund_amount = 0 THEN
        UPDATE public.reward_campaigns
        SET status = 'refunded',
            refundable_amount_luna = 0,
            closed_at = COALESCE(closed_at, _now),
            refunded_at = COALESCE(refunded_at, _now),
            updated_at = _now
        WHERE id = _campaign.id;

        RETURN jsonb_build_object(
            'result_kind', 'nothing_to_refund',
            'campaign_id', _campaign.id,
            'campaign_status', 'refunded',
            'creator_wallet', _campaign.creator_wallet,
            'vault_address_hex', _vault.vault_address_hex,
            'amount_luna', '0',
            'transaction_hash', NULL
        );
    END IF;

    INSERT INTO public.reward_refunds (
        campaign_id,
        creator_wallet,
        amount_luna,
        status
    ) VALUES (
        _campaign.id,
        _campaign.creator_wallet,
        _refund_amount,
        'pending'
    )
    RETURNING * INTO _refund;

    UPDATE public.reward_campaigns
    SET status = 'refunding',
        refundable_amount_luna = _refund_amount,
        closed_at = COALESCE(closed_at, _now),
        updated_at = _now
    WHERE id = _campaign.id;

    RETURN jsonb_build_object(
        'result_kind', 'created',
        'refund_id', _refund.id,
        'campaign_id', _campaign.id,
        'creator_wallet', _campaign.creator_wallet,
        'vault_address_hex', _vault.vault_address_hex,
        'amount_luna', _refund_amount::text,
        'status', 'pending',
        'campaign_status', 'refunding',
        'unused_reward_principal_luna', _unused_principal::text,
        'unused_fee_reserve_luna', _unused_fee::text,
        'refundable_excess_luna', _campaign.refundable_excess_luna::text,
        'ledger_refundable_amount_luna', _ledger_amount::text,
        'transaction_hash', NULL,
        'created_at', _refund.created_at,
        'closed_at', _now
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.begin_reward_refund_atomic(uuid, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.begin_reward_refund_atomic(uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.prevent_reward_campaign_refund_freeze TO service_role;
GRANT EXECUTE ON FUNCTION public.prevent_reward_receipt_after_refund_freeze TO service_role;
GRANT EXECUTE ON FUNCTION public.prevent_reward_payout_after_refund_freeze TO service_role;
GRANT EXECUTE ON FUNCTION public.prevent_reward_refund_economic_mutation TO service_role;
REVOKE EXECUTE ON FUNCTION public.prevent_reward_campaign_refund_freeze FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_reward_receipt_after_refund_freeze FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_reward_payout_after_refund_freeze FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_reward_refund_economic_mutation FROM PUBLIC, anon, authenticated;
