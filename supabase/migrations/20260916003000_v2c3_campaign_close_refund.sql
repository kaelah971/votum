-- V2C.3F Campaign refund-begin plus closed-settlement payout tolerance.
--
-- Section A creates begin_campaign_refund_atomic, the Campaign companion to
-- the Poll-only begin_reward_refund_atomic. It mirrors the Poll original
-- line-for-line except for the source branch: Campaign-branch binding
-- resolution, product closure (status closed or elapsed window) instead of
-- the Poll row gate, Campaign receipt-identity validation (NULL branch
-- columns), and a vault resolution that fails closed instead of returning a
-- null vault address. Accounting, obligation gates, idempotency, terminal
-- zero-remainder handling, grants, volatility, and search_path match the
-- audited Poll engine exactly. Refund transport/execution reuses the
-- existing generic prepare/mark/record/confirm RPCs unchanged.
--
-- Section B generalizes the payout entry/prepare gates so receipts reserved
-- BEFORE creator close can finish their earned payout lifecycle on a closed
-- settlement. Only the settlement-status allowlists change
-- (rewarding/exhausted gain closed); receipt identity, status, idempotency,
-- retry, and reconciliation semantics are untouched. Poll settlements have
-- no close writer, so Poll behavior is unchanged by construction and proven
-- by the existing Poll payout suites.

-- ============================================================================
-- Section A: begin_campaign_refund_atomic
-- ============================================================================

CREATE FUNCTION public.begin_campaign_refund_atomic(
    _settlement_id uuid,
    _session_token_hash text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    _root record; _campaign record; _vault record; _refund record; _session_wallet text; _now timestamptz:=now();
    _unresolved_count integer; _unresolved_amount bigint; _recon_count integer; _recon_amount bigint;
    _paid_amount bigint; _invalid_paid integer; _invalid_receipt integer; _confirmed_fee bigint; _missing_fee integer;
    _unused_principal bigint; _unused_fee bigint; _ledger bigint; _safe_balance bigint; _refund_amount bigint;
BEGIN
    IF _session_token_hash IS NULL OR length(trim(_session_token_hash))=0 THEN RETURN jsonb_build_object('result_kind','forbidden'); END IF;
    SELECT wallet_address INTO _session_wallet FROM public.wallet_sessions WHERE token_hash=lower(trim(_session_token_hash)) AND revoked_at IS NULL AND expires_at>_now;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','forbidden'); END IF;
    SELECT * INTO _root FROM public.reward_settlements WHERE id=_settlement_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    SELECT p.* INTO _campaign FROM public.participation_campaigns p JOIN public.settlement_source_bindings b ON b.participation_campaign_id=p.id AND b.source_type='participation_campaign' AND b.settlement_id=_root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    IF lower(trim(_root.owner_wallet))<>lower(trim(_session_wallet)) THEN RETURN jsonb_build_object('result_kind','forbidden'); END IF;
    IF lower(trim(_root.owner_wallet))<>lower(trim(_campaign.owner_wallet)) THEN RETURN jsonb_build_object('result_kind','campaign_owner_mismatch','campaign_id',_campaign.id,'settlement_id',_root.id); END IF;
    SELECT r.* INTO _refund FROM public.reward_refunds r WHERE r.settlement_id=_root.id ORDER BY r.created_at ASC,r.id ASC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      IF _root.status='refunding' THEN RETURN jsonb_build_object('result_kind','replay','refund_id',_refund.id,'campaign_id',_campaign.id,'settlement_id',_root.id,'creator_wallet',_refund.creator_wallet,'amount_luna',_refund.amount_luna::text,'status',_refund.status,'transaction_hash',_refund.transaction_hash,'created_at',_refund.created_at); END IF;
      IF _root.status='refunded' THEN RETURN jsonb_build_object('result_kind','already_refunded_or_closed','refund_id',_refund.id,'campaign_id',_campaign.id,'settlement_id',_root.id,'creator_wallet',_refund.creator_wallet,'amount_luna',_refund.amount_luna::text,'status',_refund.status,'transaction_hash',_refund.transaction_hash,'created_at',_refund.created_at); END IF;
      RETURN jsonb_build_object('result_kind','refund_state_conflict','state',_root.status);
    END IF;
    IF _root.status='refunded' THEN RETURN jsonb_build_object('result_kind','already_refunded_or_closed','campaign_id',_campaign.id,'settlement_id',_root.id,'state',_root.status,'amount_luna','0'); END IF;
    IF _root.status='refunding' THEN RETURN jsonb_build_object('result_kind','refund_intent_missing','campaign_id',_campaign.id,'settlement_id',_root.id); END IF;
    IF NOT (_campaign.status='closed' OR (_campaign.status='published' AND _campaign.ends_at IS NOT NULL AND _campaign.ends_at<=_now)) THEN RETURN jsonb_build_object('result_kind','campaign_not_closable','campaign_id',_campaign.id,'state',_root.status); END IF;
    SELECT v.vault_address_hex INTO _vault FROM public.reward_campaign_vaults v WHERE v.settlement_id=_root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','vault_not_found'); END IF;
    IF _root.status='cancelled' THEN RETURN jsonb_build_object('result_kind','campaign_not_closable','campaign_id',_campaign.id,'state',_root.status); END IF;
    IF _root.status NOT IN ('closed','funded','rewarding','exhausted') THEN RETURN jsonb_build_object('result_kind','campaign_not_closable','campaign_id',_campaign.id,'state',_root.status); END IF;

    SELECT COALESCE(count(*) FILTER(WHERE r.status IN ('reserved','payout_pending','retryable')),0)::integer,
           COALESCE(sum(r.amount_luna) FILTER(WHERE r.status IN ('reserved','payout_pending','retryable')),0)::bigint,
           COALESCE(count(*) FILTER(WHERE r.status<>'paid' AND EXISTS(SELECT 1 FROM public.reward_payout_attempts a WHERE a.receipt_id=r.id AND (a.transaction_hash IS NOT NULL OR a.broadcast_started_at IS NOT NULL OR a.broadcast_at IS NOT NULL OR a.status='confirmed' OR lower(COALESCE(a.error_code,'')) LIKE '%unknown%' OR lower(COALESCE(a.error_code,'')) LIKE '%manual%'))),0)::integer,
           COALESCE(sum(r.amount_luna) FILTER(WHERE r.status<>'paid' AND EXISTS(SELECT 1 FROM public.reward_payout_attempts a WHERE a.receipt_id=r.id AND (a.transaction_hash IS NOT NULL OR a.broadcast_started_at IS NOT NULL OR a.broadcast_at IS NOT NULL OR a.status='confirmed' OR lower(COALESCE(a.error_code,'')) LIKE '%unknown%' OR lower(COALESCE(a.error_code,'')) LIKE '%manual%'))),0)::bigint
      INTO _unresolved_count,_unresolved_amount,_recon_count,_recon_amount FROM public.reward_receipts r WHERE r.settlement_id=_root.id;
    SELECT COALESCE(sum(r.amount_luna) FILTER(WHERE r.status='paid'),0)::bigint,
           COALESCE(count(*) FILTER(WHERE r.status='paid' AND r.paid_at IS NULL),0)::integer,
           COALESCE(count(*) FILTER(WHERE r.campaign_id IS NOT NULL OR r.poll_id IS NOT NULL),0)::integer
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
    INSERT INTO public.reward_refunds(campaign_id,settlement_id,creator_wallet,amount_luna,status) VALUES(NULL,_root.id,_root.refund_recipient_wallet,_refund_amount,'pending') RETURNING * INTO _refund;
    UPDATE public.reward_settlements SET status='refunding',refundable_amount_luna=_refund_amount,closed_at=COALESCE(closed_at,_now),updated_at=_now WHERE id=_root.id;
    RETURN jsonb_build_object('result_kind','created','refund_id',_refund.id,'campaign_id',_campaign.id,'settlement_id',_root.id,'creator_wallet',_root.refund_recipient_wallet,'vault_address_hex',_vault.vault_address_hex,'amount_luna',_refund_amount::text,'status','pending','campaign_status','refunding','unused_reward_principal_luna',_unused_principal::text,'unused_fee_reserve_luna',_unused_fee::text,'refundable_excess_luna',_root.refundable_excess_luna::text,'ledger_refundable_amount_luna',_ledger::text,'transaction_hash',NULL,'created_at',_refund.created_at,'closed_at',_now);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.begin_campaign_refund_atomic(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_campaign_refund_atomic(uuid, text) TO service_role;

-- ============================================================================
-- Section B: closed-settlement payout tolerance.
--
-- begin_reward_payout_atomic and prepare_reward_payout_atomic reject any
-- settlement outside (rewarding, exhausted). Creator close moves the
-- settlement to closed while pre-existing receipts may still be mid-payout,
-- so both gates additionally accept closed. Reachability is already scoped:
-- begin only admits reserved receipts and prepare only pending attempts on
-- payout_pending receipts, and no new receipt can be created once the
-- settlement is closed (M3 rejects; the refund-freeze trigger backstops).
-- Poll settlements have no close writer, so Poll behavior is unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.begin_reward_payout_atomic(_receipt_id uuid, _campaign_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _root record; _campaign record; _pcampaign_id uuid; _receipt record; _vault record; _attempt record; _n integer;
BEGIN
    SELECT * INTO _root FROM public.reward_settlements WHERE id=_campaign_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    SELECT c.* INTO _campaign FROM public.reward_campaigns c JOIN public.settlement_source_bindings b ON b.reward_campaign_id=c.id AND b.source_type='poll_reward_campaign' AND b.settlement_id=_root.id;
    IF FOUND THEN
        SELECT r.id,r.campaign_id,r.settlement_id,r.poll_id,r.participant_wallet,r.amount_luna,r.status INTO _receipt
          FROM public.reward_receipts r WHERE r.id=_receipt_id AND r.settlement_id=_root.id AND r.campaign_id=_campaign.id FOR UPDATE;
        IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','receipt_not_found'); END IF;
        IF _receipt.poll_id<>_campaign.poll_id THEN RETURN jsonb_build_object('result_kind','receipt_campaign_mismatch'); END IF;
    ELSE
        SELECT p.id INTO _pcampaign_id FROM public.participation_campaigns p
        JOIN public.settlement_source_bindings b ON b.participation_campaign_id=p.id
          AND b.source_type='participation_campaign' AND b.settlement_id=_root.id;
        IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
        SELECT r.id,r.campaign_id,r.settlement_id,r.poll_id,r.participant_wallet,r.amount_luna,r.status INTO _receipt
          FROM public.reward_receipts r WHERE r.id=_receipt_id AND r.settlement_id=_root.id AND r.campaign_id IS NULL FOR UPDATE;
        IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','receipt_not_found'); END IF;
    END IF;
    IF _receipt.status='paid' THEN RETURN jsonb_build_object('result_kind','receipt_paid'); END IF;
    IF _receipt.status IN ('failed','retryable') THEN RETURN jsonb_build_object('result_kind','receipt_state_conflict','state',_receipt.status); END IF;
    SELECT a.* INTO _attempt FROM public.reward_payout_attempts a WHERE a.receipt_id=_receipt.id ORDER BY a.attempt_number DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      IF _receipt.status='payout_pending' AND _attempt.status='pending' THEN
        SELECT v.vault_address_hex INTO _vault FROM public.reward_campaign_vaults v WHERE v.settlement_id=_root.id;
        RETURN jsonb_build_object('result_kind','replay','attempt_id',_attempt.id,'receipt_id',_receipt.id,'campaign_id',COALESCE(_campaign.id, _pcampaign_id),'settlement_id',_root.id,'attempt_number',_attempt.attempt_number,'attempt_status',_attempt.status,'receipt_status',_receipt.status,'participant_wallet',_receipt.participant_wallet,'amount_luna',_receipt.amount_luna::text,'vault_address_hex',_vault.vault_address_hex,'prepared_transaction_hex',_attempt.prepared_transaction_hex,'transaction_hash',_attempt.transaction_hash,'sender_address_hex',_attempt.sender_address_hex,'recipient_address_hex',_attempt.recipient_address_hex,'fee_luna',_attempt.fee_luna::text,'network_id',_attempt.network_id,'validity_start_height',_attempt.validity_start_height,'prepared_at',_attempt.prepared_at,'broadcast_started_at',_attempt.broadcast_started_at,'broadcast_at',_attempt.broadcast_at);
      END IF;
      RETURN jsonb_build_object('result_kind','payout_state_inconsistent');
    END IF;
    IF _receipt.status<>'reserved' THEN RETURN jsonb_build_object('result_kind','receipt_not_reserved','state',_receipt.status); END IF;
    IF _root.status NOT IN ('rewarding','exhausted','closed') THEN RETURN jsonb_build_object('result_kind','campaign_not_rewarding','state',_root.status); END IF;
    SELECT v.vault_address_hex INTO _vault FROM public.reward_campaign_vaults v WHERE v.settlement_id=_root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','vault_not_found'); END IF;
    SELECT COALESCE(MAX(a.attempt_number),0)+1 INTO _n FROM public.reward_payout_attempts a WHERE a.receipt_id=_receipt.id;
    INSERT INTO public.reward_payout_attempts(receipt_id,attempt_number,status) VALUES(_receipt.id,_n,'pending') RETURNING * INTO _attempt;
    UPDATE public.reward_receipts SET status='payout_pending',updated_at=now() WHERE id=_receipt.id AND status='reserved';
    RETURN jsonb_build_object('result_kind','created','attempt_id',_attempt.id,'receipt_id',_receipt.id,'campaign_id',COALESCE(_campaign.id, _pcampaign_id),'settlement_id',_root.id,'attempt_number',_attempt.attempt_number,'attempt_status',_attempt.status,'receipt_status','payout_pending','participant_wallet',_receipt.participant_wallet,'amount_luna',_receipt.amount_luna::text,'vault_address_hex',_vault.vault_address_hex,'prepared_transaction_hex',NULL,'transaction_hash',NULL,'sender_address_hex',NULL,'recipient_address_hex',NULL,'fee_luna',NULL,'network_id',NULL,'validity_start_height',NULL,'prepared_at',NULL,'broadcast_started_at',NULL,'broadcast_at',NULL);
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
    IF _attempt.settlement_status NOT IN ('rewarding','exhausted','closed') THEN RETURN jsonb_build_object('result_kind','campaign_not_rewarding'); END IF;
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

-- ============================================================================
-- Section C: Campaign payout-lifecycle exception for the refund freeze.
--
-- Creator close moves the settlement to closed while pre-existing Campaign
-- receipts may still be mid-payout. The settlement-keyed freeze guards would
-- otherwise reject every receipt/attempt write on a closed settlement,
-- stranding earned payouts and violating reservation survival. This section
-- teaches both guards one narrow exception; every other path keeps its
-- exact existing behavior:
--
-- - refunding/refunded settlements: freeze in force for everything, both
--   branches, exactly as before.
-- - Poll-branch rows (campaign_id NOT NULL): freeze in force exactly as
--   before. Poll settlements additionally have no close writer, so the
--   exception is unreachable for them.
-- - Campaign-branch receipt INSERT after close: still rejected (no new
--   entitlements). DELETE, settlement moves, identity rewrites, amount
--   rewrites, and non-lifecycle transitions: still rejected.
-- - Campaign-branch receipt UPDATE on a closed settlement is allowed ONLY
--   for payout-lifecycle transitions of the same row with frozen identity
--   and amount: reserved->payout_pending, payout_pending->paid,
--   payout_pending->retryable, retryable->payout_pending.
-- - Campaign-branch payout-attempt writes on a closed settlement are
--   allowed ONLY for the same settlement's existing Campaign receipt;
--   DELETE and receipt_id moves still raise. (Preserved quirk: attempt
--   INSERT resolution already bypasses the status check via the
--   receipt-link lookup, exactly as before; the RPC layer remains the
--   authority for attempt creation.)
-- ============================================================================

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
        IF _status = 'closed' AND TG_OP = 'UPDATE'
           AND NEW.id IS NOT DISTINCT FROM OLD.id
           AND NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id
           AND NEW.campaign_id IS NULL AND OLD.campaign_id IS NULL
           AND NEW.poll_id IS NULL AND OLD.poll_id IS NULL
           AND NEW.participant_wallet IS NOT DISTINCT FROM OLD.participant_wallet
           AND NEW.amount_luna IS NOT DISTINCT FROM OLD.amount_luna
           AND ((OLD.status = 'reserved' AND NEW.status = 'payout_pending')
             OR (OLD.status = 'payout_pending' AND NEW.status IN ('paid', 'retryable'))
             OR (OLD.status = 'retryable' AND NEW.status = 'payout_pending')) THEN
            RETURN NEW;
        END IF;
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
    _receipt_settlement uuid;
    _receipt_campaign uuid;
    _receipt_poll uuid;
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
        IF _status = 'closed' AND TG_OP <> 'DELETE' THEN
            SELECT r.settlement_id, r.campaign_id, r.poll_id
              INTO _receipt_settlement, _receipt_campaign, _receipt_poll
              FROM public.reward_receipts r WHERE r.id = NEW.receipt_id;
            IF _receipt_settlement IS NOT DISTINCT FROM _settlement_id
               AND _receipt_campaign IS NULL AND _receipt_poll IS NULL THEN
                RETURN NEW;
            END IF;
        END IF;
        RAISE EXCEPTION 'payout obligations are blocked after refund preparation'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- ============================================================================
-- Section D: Campaign payout-settlement exception for the settlement freeze.
--
-- prevent_reward_settlement_refund_freeze rejects every economics write once
-- the settlement is closed/refunding/refunded. Creator close moves the
-- settlement to closed while pre-existing Campaign receipts may still be
-- mid-payout, so confirming a payout (paid_amount_luna), accruing its fee
-- (fee_spent_luna), or holding the vault lease across the external network
-- call would otherwise be impossible and earned reservations could never
-- settle. This section allows exactly that payout-settlement movement while
-- the status stays closed; every other economics field stays frozen, and
-- refunding/refunded keep the full freeze. Poll settlements have no close
-- writer, so this branch is unreachable for them and Poll behavior is
-- unchanged.
-- ============================================================================

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

    IF OLD.status = 'closed' AND NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.owner_wallet IS NOT DISTINCT FROM OLD.owner_wallet
       AND NEW.funding_wallet IS NOT DISTINCT FROM OLD.funding_wallet
       AND NEW.refund_recipient_wallet IS NOT DISTINCT FROM OLD.refund_recipient_wallet
       AND NEW.funding_mode IS NOT DISTINCT FROM OLD.funding_mode
       AND NEW.asset IS NOT DISTINCT FROM OLD.asset
       AND NEW.reward_per_participant_luna IS NOT DISTINCT FROM OLD.reward_per_participant_luna
       AND NEW.max_rewarded_participants IS NOT DISTINCT FROM OLD.max_rewarded_participants
       AND NEW.reward_principal_luna IS NOT DISTINCT FROM OLD.reward_principal_luna
       AND NEW.fee_reserve_luna IS NOT DISTINCT FROM OLD.fee_reserve_luna
       AND NEW.total_budget_luna IS NOT DISTINCT FROM OLD.total_budget_luna
       AND NEW.funded_amount_luna IS NOT DISTINCT FROM OLD.funded_amount_luna
       AND NEW.refundable_excess_luna IS NOT DISTINCT FROM OLD.refundable_excess_luna
       AND NEW.rewarded_participant_count IS NOT DISTINCT FROM OLD.rewarded_participant_count
       AND NEW.refundable_amount_luna IS NOT DISTINCT FROM OLD.refundable_amount_luna
       AND NEW.first_reservation_at IS NOT DISTINCT FROM OLD.first_reservation_at
       AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
       AND NEW.funded_at IS NOT DISTINCT FROM OLD.funded_at
       AND NEW.closed_at IS NOT DISTINCT FROM OLD.closed_at
       AND NEW.refunded_at IS NOT DISTINCT FROM OLD.refunded_at THEN
        RETURN NEW;
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
