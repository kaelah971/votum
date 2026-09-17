-- V2C.3D payout-entry compatibility cutover.
--
-- begin_reward_payout_atomic and retry_reward_payout_atomic resolved only
-- the Poll compatibility branch (reward_campaigns), so no Campaign receipt
-- (campaign_id IS NULL / poll_id IS NULL by the D-branch contract) could
-- ever enter the payout engine. This migration generalizes exactly those
-- two entry RPCs with settlement source-branch resolution following the
-- approved M2 funding cutover pattern:
--
--   Poll branch:     unchanged behavior, identity, codes.
--   Campaign branch: settlement-authoritative receipt identity
--                    (id + settlement_id + campaign_id IS NULL),
--                    no reward_campaigns dependence.
--
-- Every downstream payout operation (prepare, broadcast markers, failure /
-- unknown recording, vault lease, confirmation) is already
-- settlement/attempt-keyed and generic, so no other payout function
-- changes. Error vocabulary is unchanged for both branches, so no
-- server-side caller changes. Version 20260916002500 is used instead of
-- 20260916003000 to keep the planned V2C.3F close/refund migration number
-- collision-free.

DROP FUNCTION IF EXISTS public.begin_reward_payout_atomic(uuid, uuid);
CREATE FUNCTION public.begin_reward_payout_atomic(_receipt_id uuid, _campaign_id uuid)
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
    IF _root.status NOT IN ('rewarding','exhausted') THEN RETURN jsonb_build_object('result_kind','campaign_not_rewarding','state',_root.status); END IF;
    SELECT v.vault_address_hex INTO _vault FROM public.reward_campaign_vaults v WHERE v.settlement_id=_root.id;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','vault_not_found'); END IF;
    SELECT COALESCE(MAX(a.attempt_number),0)+1 INTO _n FROM public.reward_payout_attempts a WHERE a.receipt_id=_receipt.id;
    INSERT INTO public.reward_payout_attempts(receipt_id,attempt_number,status) VALUES(_receipt.id,_n,'pending') RETURNING * INTO _attempt;
    UPDATE public.reward_receipts SET status='payout_pending',updated_at=now() WHERE id=_receipt.id AND status='reserved';
    RETURN jsonb_build_object('result_kind','created','attempt_id',_attempt.id,'receipt_id',_receipt.id,'campaign_id',COALESCE(_campaign.id, _pcampaign_id),'settlement_id',_root.id,'attempt_number',_attempt.attempt_number,'attempt_status',_attempt.status,'receipt_status','payout_pending','participant_wallet',_receipt.participant_wallet,'amount_luna',_receipt.amount_luna::text,'vault_address_hex',_vault.vault_address_hex,'prepared_transaction_hex',NULL,'transaction_hash',NULL,'sender_address_hex',NULL,'recipient_address_hex',NULL,'fee_luna',NULL,'network_id',NULL,'validity_start_height',NULL,'prepared_at',NULL,'broadcast_started_at',NULL,'broadcast_at',NULL);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('result_kind','payout_attempt_conflict');
END;
$$;

DROP FUNCTION IF EXISTS public.retry_reward_payout_atomic(uuid, uuid);
CREATE FUNCTION public.retry_reward_payout_atomic(_receipt_id uuid, _campaign_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _root record; _campaign record; _pcampaign_id uuid; _receipt record; _attempt record; _n integer;
BEGIN
    SELECT * INTO _root FROM public.reward_settlements WHERE id=_campaign_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
    SELECT c.* INTO _campaign FROM public.reward_campaigns c JOIN public.settlement_source_bindings b ON b.reward_campaign_id=c.id AND b.source_type='poll_reward_campaign' AND b.settlement_id=_root.id;
    IF FOUND THEN
        SELECT r.* INTO _receipt FROM public.reward_receipts r WHERE r.id=_receipt_id AND r.settlement_id=_root.id AND r.campaign_id=_campaign.id FOR UPDATE;
    ELSE
        SELECT p.id INTO _pcampaign_id FROM public.participation_campaigns p
        JOIN public.settlement_source_bindings b ON b.participation_campaign_id=p.id
          AND b.source_type='participation_campaign' AND b.settlement_id=_root.id;
        IF NOT FOUND THEN RETURN jsonb_build_object('result_kind','campaign_not_found'); END IF;
        SELECT r.* INTO _receipt FROM public.reward_receipts r WHERE r.id=_receipt_id AND r.settlement_id=_root.id AND r.campaign_id IS NULL FOR UPDATE;
    END IF;
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
    RETURN jsonb_build_object('result_kind','retryable','attempt_id',_attempt.id,'receipt_id',_receipt.id,'campaign_id',COALESCE(_campaign.id, _pcampaign_id),'settlement_id',_root.id,'attempt_number',_attempt.attempt_number,'attempt_status',_attempt.status,'receipt_status','payout_pending','participant_wallet',_receipt.participant_wallet,'amount_luna',_receipt.amount_luna::text);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('result_kind','payout_attempt_conflict');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.begin_reward_payout_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.retry_reward_payout_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_reward_payout_atomic(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.retry_reward_payout_atomic(uuid, uuid) TO service_role;
