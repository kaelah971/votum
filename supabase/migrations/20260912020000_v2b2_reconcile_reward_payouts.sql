-- V2B.2.8 — observe, verify, finalize, and atomically settle reward payouts.
--
-- A broadcast hash is not payment proof. This boundary accepts only the
-- server-observed exact payout plus canonical micro-block and macro-block
-- finality evidence produced by src/lib/nimiq/observation.ts.

-- ============================================================================
-- Persist the chain evidence needed to audit a paid payout.
-- ============================================================================

ALTER TABLE public.reward_payout_attempts
  ADD COLUMN IF NOT EXISTS confirmed_network_id integer,
  ADD COLUMN IF NOT EXISTS confirmed_block_number bigint,
  ADD COLUMN IF NOT EXISTS confirmed_transaction_timestamp timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_transaction_block_hash text,
  ADD COLUMN IF NOT EXISTS confirmed_canonical_block_hash text,
  ADD COLUMN IF NOT EXISTS confirmed_batch_number bigint,
  ADD COLUMN IF NOT EXISTS confirmed_finalizing_macro_block_height bigint,
  ADD COLUMN IF NOT EXISTS confirmed_finalizing_macro_block_hash text;

ALTER TABLE public.reward_payout_attempts
  ADD CONSTRAINT reward_payout_confirmed_network_nonneg
    CHECK (confirmed_network_id IS NULL OR confirmed_network_id >= 0),
  ADD CONSTRAINT reward_payout_confirmed_block_nonneg
    CHECK (confirmed_block_number IS NULL OR confirmed_block_number >= 0),
  ADD CONSTRAINT reward_payout_confirmed_batch_nonneg
    CHECK (confirmed_batch_number IS NULL OR confirmed_batch_number >= 0),
  ADD CONSTRAINT reward_payout_confirmed_macro_height_nonneg
    CHECK (
      confirmed_finalizing_macro_block_height IS NULL
      OR confirmed_finalizing_macro_block_height >= 0
    ),
  ADD CONSTRAINT reward_payout_confirmed_block_hash_format
    CHECK (
      confirmed_transaction_block_hash IS NULL
      OR confirmed_transaction_block_hash ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT reward_payout_confirmed_canonical_hash_format
    CHECK (
      confirmed_canonical_block_hash IS NULL
      OR confirmed_canonical_block_hash ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT reward_payout_confirmed_macro_hash_format
    CHECK (
      confirmed_finalizing_macro_block_hash IS NULL
      OR confirmed_finalizing_macro_block_hash ~ '^[0-9a-f]{64}$'
    );

CREATE INDEX IF NOT EXISTS idx_reward_payout_pending_reconciliation
  ON public.reward_payout_attempts (status, transaction_hash)
  WHERE status = 'pending' AND transaction_hash IS NOT NULL;

-- ============================================================================
-- Atomic final paid transition. All inputs are server-produced observations;
-- the function still compares every economic term to persisted authority.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.confirm_reward_payout_atomic(
    _attempt_id                         uuid,
    _receipt_id                         uuid,
    _campaign_id                        uuid,
    _transaction_hash                   text,
    _network_id                         integer,
    _observed_sender                    text,
    _observed_recipient                 text,
    _observed_amount_luna               bigint,
    _execution_result                   boolean,
    _block_number                       bigint,
    _transaction_timestamp              timestamptz,
    _transaction_block_hash             text,
    _canonical_block_hash               text,
    _batch_number                       bigint,
    _finalizing_macro_block_height      bigint,
    _finalizing_macro_block_hash        text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _attempt record;
    _receipt record;
    _campaign record;
    _vault record;
    _hash text := lower(trim(COALESCE(_transaction_hash, '')));
    _sender text := lower(trim(COALESCE(_observed_sender, '')));
    _recipient text := lower(trim(COALESCE(_observed_recipient, '')));
    _block_hash text := CASE
        WHEN _transaction_block_hash IS NULL THEN NULL
        ELSE lower(trim(_transaction_block_hash))
    END;
    _canonical_hash text := lower(trim(COALESCE(_canonical_block_hash, '')));
    _macro_hash text := lower(trim(COALESCE(_finalizing_macro_block_hash, '')));
    _confirmed_at timestamptz;
BEGIN
    IF _hash !~ '^[0-9a-f]{64}$' THEN
        RETURN jsonb_build_object('result_kind', 'invalid_hash');
    END IF;

    IF _network_id IS NULL OR _network_id < 0
       OR _observed_amount_luna IS NULL OR _observed_amount_luna <= 0
       OR _execution_result IS DISTINCT FROM true
       OR _block_number IS NULL OR _block_number < 0
       OR _canonical_hash !~ '^[0-9a-f]{64}$'
       OR _batch_number IS NULL OR _batch_number < 0
       OR _finalizing_macro_block_height IS NULL
       OR _finalizing_macro_block_height < _block_number
        OR _macro_hash !~ '^[0-9a-f]{64}$'
        OR _sender !~ '^[0-9a-f]{40}$'
        OR _recipient !~ '^[0-9a-f]{40}$'
        OR (_block_hash IS NOT NULL AND _block_hash !~ '^[0-9a-f]{64}$') THEN
        RETURN jsonb_build_object('result_kind', 'invalid_observation');
    END IF;

    -- Lock the attempt first, then its receipt and campaign. No state can be
    -- paid without the exact attempt/receipt/campaign relationship.
    SELECT a.*
    INTO _attempt
    FROM public.reward_payout_attempts a
    WHERE a.id = _attempt_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'attempt_not_found');
    END IF;

    SELECT r.*
    INTO _receipt
    FROM public.reward_receipts r
    WHERE r.id = _attempt.receipt_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'receipt_not_found');
    END IF;

    SELECT c.*
    INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _receipt.campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;

    IF _attempt.receipt_id <> _receipt_id
       OR _receipt.campaign_id <> _campaign_id
       OR _attempt.id <> _attempt_id
       OR _campaign.id <> _campaign_id
       OR _receipt.poll_id <> _campaign.poll_id THEN
        RETURN jsonb_build_object('result_kind', 'attempt_receipt_mismatch');
    END IF;

    SELECT v.vault_address_hex
    INTO _vault
    FROM public.reward_campaign_vaults v
    WHERE v.campaign_id = _campaign.id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'vault_not_found');
    END IF;

    IF _attempt.transaction_hash IS NULL THEN
        RETURN jsonb_build_object('result_kind', 'missing_stored_hash');
    END IF;
    IF lower(trim(_attempt.transaction_hash)) <> _hash THEN
        RETURN jsonb_build_object('result_kind', 'hash_mismatch');
    END IF;
    IF _attempt.network_id IS NULL OR _attempt.network_id <> _network_id THEN
        RETURN jsonb_build_object('result_kind', 'wrong_network');
    END IF;
    IF lower(trim(_vault.vault_address_hex)) <> _sender THEN
        RETURN jsonb_build_object('result_kind', 'wrong_sender');
    END IF;
    IF lower(trim(_receipt.participant_wallet)) <> _recipient THEN
        RETURN jsonb_build_object('result_kind', 'wrong_recipient');
    END IF;
    IF _receipt.amount_luna <> _observed_amount_luna THEN
        RETURN jsonb_build_object('result_kind', 'amount_mismatch');
    END IF;

    -- A duplicate successful reconciliation is side-effect free. It is checked
    -- only after all supplied authoritative terms have matched the ledger.
    IF _attempt.status = 'confirmed' AND _receipt.status = 'paid' THEN
        RETURN jsonb_build_object(
            'result_kind', 'replay',
            'attempt_id', _attempt.id,
            'receipt_id', _receipt.id,
            'campaign_id', _campaign.id,
            'transaction_hash', _attempt.transaction_hash,
            'confirmed_at', _attempt.confirmed_at,
            'paid_at', _receipt.paid_at
        );
    END IF;

    IF _attempt.status <> 'pending' OR _receipt.status <> 'payout_pending' THEN
        RETURN jsonb_build_object('result_kind', 'payout_state_conflict');
    END IF;
    IF _attempt.broadcast_started_at IS NULL THEN
        RETURN jsonb_build_object('result_kind', 'broadcast_not_started');
    END IF;
    IF _campaign.paid_amount_luna + _receipt.amount_luna + _campaign.fee_spent_luna
       > _campaign.funded_amount_luna THEN
        RETURN jsonb_build_object('result_kind', 'payout_accounting_conflict');
    END IF;

    _confirmed_at := COALESCE(_attempt.confirmed_at, now());

    UPDATE public.reward_payout_attempts
    SET status = 'confirmed',
        confirmed_at = _confirmed_at,
        confirmed_network_id = _network_id,
        confirmed_block_number = _block_number,
        confirmed_transaction_timestamp = _transaction_timestamp,
        confirmed_transaction_block_hash = _block_hash,
        confirmed_canonical_block_hash = _canonical_hash,
        confirmed_batch_number = _batch_number,
        confirmed_finalizing_macro_block_height = _finalizing_macro_block_height,
        confirmed_finalizing_macro_block_hash = _macro_hash,
        error_code = NULL,
        updated_at = _confirmed_at
    WHERE id = _attempt.id;

    UPDATE public.reward_receipts
    SET status = 'paid',
        paid_at = COALESCE(paid_at, _confirmed_at),
        updated_at = _confirmed_at
    WHERE id = _receipt.id;

    UPDATE public.reward_campaigns
    SET paid_amount_luna = paid_amount_luna + _receipt.amount_luna,
        updated_at = _confirmed_at
    WHERE id = _campaign.id;

    RETURN jsonb_build_object(
        'result_kind', 'confirmed',
        'attempt_id', _attempt.id,
        'receipt_id', _receipt.id,
        'campaign_id', _campaign.id,
        'transaction_hash', _hash,
        'amount_luna', _receipt.amount_luna::text,
        'confirmed_at', _confirmed_at,
        'paid_at', _confirmed_at,
        'confirmed_block_number', _block_number,
        'confirmed_canonical_block_hash', _canonical_hash,
        'confirmed_batch_number', _batch_number,
        'confirmed_finalizing_macro_block_height', _finalizing_macro_block_height,
        'confirmed_finalizing_macro_block_hash', _macro_hash
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_reward_payout_atomic(
    uuid, uuid, uuid, text, integer, text, text, bigint, boolean, bigint,
    timestamptz, text, text, bigint, bigint, text
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.confirm_reward_payout_atomic(
    uuid, uuid, uuid, text, integer, text, text, bigint, boolean, bigint,
    timestamptz, text, text, bigint, bigint, text
) FROM PUBLIC, anon, authenticated;
