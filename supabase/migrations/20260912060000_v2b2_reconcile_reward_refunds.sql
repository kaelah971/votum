-- V2B.2.11 Phase D — observe and atomically finalize one creator refund.
--
-- A broadcast hash is not refund proof. This boundary accepts only a
-- server-observed exact transfer with canonical micro-block and finalizing
-- macro-block evidence, then closes the campaign in one transaction.

-- ============================================================================
-- Persist the chain evidence needed to audit a confirmed refund.
-- ============================================================================

ALTER TABLE public.reward_refunds
  ADD COLUMN IF NOT EXISTS confirmed_network_id integer,
  ADD COLUMN IF NOT EXISTS confirmed_transaction_block_hash text,
  ADD COLUMN IF NOT EXISTS confirmed_canonical_block_hash text,
  ADD COLUMN IF NOT EXISTS confirmed_batch_number bigint,
  ADD COLUMN IF NOT EXISTS confirmed_finalizing_macro_block_height bigint,
  ADD COLUMN IF NOT EXISTS confirmed_finalizing_macro_block_hash text;

ALTER TABLE public.reward_refunds
  ADD CONSTRAINT reward_refund_confirmed_network_nonneg
    CHECK (confirmed_network_id IS NULL OR confirmed_network_id >= 0),
  ADD CONSTRAINT reward_refund_confirmed_block_nonneg
    CHECK (block_number IS NULL OR block_number >= 0),
  ADD CONSTRAINT reward_refund_confirmed_batch_nonneg
    CHECK (confirmed_batch_number IS NULL OR confirmed_batch_number >= 0),
  ADD CONSTRAINT reward_refund_confirmed_macro_height_nonneg
    CHECK (
      confirmed_finalizing_macro_block_height IS NULL
      OR confirmed_finalizing_macro_block_height >= 0
    ),
  ADD CONSTRAINT reward_refund_confirmed_block_hash_format
    CHECK (
      confirmed_transaction_block_hash IS NULL
      OR confirmed_transaction_block_hash ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT reward_refund_confirmed_canonical_hash_format
    CHECK (
      confirmed_canonical_block_hash IS NULL
      OR confirmed_canonical_block_hash ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT reward_refund_confirmed_macro_hash_format
    CHECK (
      confirmed_finalizing_macro_block_hash IS NULL
      OR confirmed_finalizing_macro_block_hash ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT reward_refund_confirmation_fields_complete
    CHECK (
      status <> 'confirmed'
      OR (
        transaction_hash IS NOT NULL
        AND confirmed_at IS NOT NULL
        AND block_number IS NOT NULL
        AND confirmed_network_id IS NOT NULL
        AND confirmed_canonical_block_hash IS NOT NULL
        AND confirmed_batch_number IS NOT NULL
        AND confirmed_finalizing_macro_block_height IS NOT NULL
        AND confirmed_finalizing_macro_block_hash IS NOT NULL
      )
    );

CREATE INDEX IF NOT EXISTS idx_reward_refunds_pending_reconciliation
  ON public.reward_refunds (status, transaction_hash)
  WHERE status = 'pending' AND transaction_hash IS NOT NULL;

-- A confirmed refund is immutable. Replay is handled by the confirmation RPC
-- before any update, so direct service-role writes cannot alter terminal proof.
CREATE OR REPLACE FUNCTION public.prevent_confirmed_reward_refund_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF OLD.status = 'confirmed' THEN
        RAISE EXCEPTION 'confirmed refund cannot be mutated'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reward_refund_confirmed_mutation_guard
  ON public.reward_refunds;

CREATE TRIGGER reward_refund_confirmed_mutation_guard
  BEFORE UPDATE OR DELETE ON public.reward_refunds
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_confirmed_reward_refund_mutation();

-- ============================================================================
-- Atomic final confirmed/refunded transition.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.confirm_reward_refund_atomic(
    _refund_id                         uuid,
    _campaign_id                       uuid,
    _transaction_hash                  text,
    _network_id                        integer,
    _observed_sender                   text,
    _observed_recipient                text,
    _observed_amount_luna              bigint,
    _execution_result                  boolean,
    _block_number                      bigint,
    _transaction_timestamp             timestamptz,
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
    _refund record;
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

    SELECT r.* INTO _refund
    FROM public.reward_refunds r
    WHERE r.id = _refund_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'refund_not_found');
    END IF;

    SELECT c.* INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;
    IF _refund.campaign_id <> _campaign.id THEN
        RETURN jsonb_build_object('result_kind', 'refund_campaign_mismatch');
    END IF;

    SELECT v.vault_address_hex INTO _vault
    FROM public.reward_campaign_vaults v
    WHERE v.campaign_id = _campaign.id
    FOR SHARE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'vault_not_found');
    END IF;

    -- Every submitted field is compared with the frozen local authority. The
    -- observed chain response cannot choose a different destination or amount.
    IF _refund.transaction_hash IS NULL
       OR lower(trim(_refund.transaction_hash)) <> _hash THEN
        RETURN jsonb_build_object('result_kind', 'hash_mismatch');
    END IF;
    IF _refund.network_id IS NULL OR _refund.network_id <> _network_id THEN
        RETURN jsonb_build_object('result_kind', 'wrong_network');
    END IF;
    IF lower(trim(COALESCE(_refund.sender_address_hex, ''))) <> lower(trim(_vault.vault_address_hex))
       OR _sender <> lower(trim(_vault.vault_address_hex)) THEN
        RETURN jsonb_build_object('result_kind', 'wrong_sender');
    END IF;
    IF lower(trim(COALESCE(_refund.recipient_address_hex, ''))) <> lower(trim(_refund.creator_wallet))
       OR _recipient <> lower(trim(_refund.creator_wallet)) THEN
        RETURN jsonb_build_object('result_kind', 'wrong_recipient');
    END IF;
    IF _refund.amount_luna <> _observed_amount_luna
       OR _campaign.refundable_amount_luna <> _refund.amount_luna
       OR lower(trim(_campaign.creator_wallet)) <> lower(trim(_refund.creator_wallet)) THEN
        RETURN jsonb_build_object('result_kind', 'amount_mismatch');
    END IF;

    -- A duplicate exact confirmation is side-effect free. It is evaluated only
    -- after the stored transaction identity and economics match the request.
    IF _refund.status = 'confirmed' AND _campaign.status = 'refunded' THEN
        RETURN jsonb_build_object(
            'result_kind', 'replay',
            'refund_id', _refund.id,
            'campaign_id', _campaign.id,
            'transaction_hash', _refund.transaction_hash,
            'confirmed_at', _refund.confirmed_at,
            'refunded_at', _campaign.refunded_at
        );
    END IF;

    IF _campaign.status <> 'refunding' OR _refund.status <> 'pending' THEN
        RETURN jsonb_build_object('result_kind', 'refund_state_conflict');
    END IF;
    IF _refund.broadcast_started_at IS NULL OR _refund.broadcast_at IS NULL THEN
        RETURN jsonb_build_object('result_kind', 'broadcast_not_confirmable');
    END IF;

    _confirmed_at := COALESCE(_refund.confirmed_at, now());

    UPDATE public.reward_refunds
    SET status = 'confirmed',
        block_number = _block_number,
        transaction_timestamp = _transaction_timestamp,
        confirmed_at = _confirmed_at,
        confirmed_network_id = _network_id,
        confirmed_transaction_block_hash = _block_hash,
        confirmed_canonical_block_hash = _canonical_hash,
        confirmed_batch_number = _batch_number,
        confirmed_finalizing_macro_block_height = _finalizing_macro_block_height,
        confirmed_finalizing_macro_block_hash = _macro_hash,
        error_code = NULL,
        updated_at = _confirmed_at
    WHERE id = _refund.id;

    -- The campaign trigger requires the confirmed refund proof before allowing
    -- the single refunding -> refunded transition.
    UPDATE public.reward_campaigns
    SET status = 'refunded',
        refunded_at = COALESCE(refunded_at, _confirmed_at),
        updated_at = _confirmed_at
    WHERE id = _campaign.id;

    RETURN jsonb_build_object(
        'result_kind', 'confirmed',
        'refund_id', _refund.id,
        'campaign_id', _campaign.id,
        'transaction_hash', _hash,
        'amount_luna', _refund.amount_luna::text,
        'confirmed_at', _confirmed_at,
        'refunded_at', _confirmed_at,
        'block_number', _block_number,
        'confirmed_canonical_block_hash', _canonical_hash,
        'confirmed_batch_number', _batch_number,
        'confirmed_finalizing_macro_block_height', _finalizing_macro_block_height,
        'confirmed_finalizing_macro_block_hash', _macro_hash
    );
EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object('result_kind', 'transaction_hash_conflict');
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_reward_refund_atomic(
    uuid, uuid, text, integer, text, text, bigint, boolean, bigint,
    timestamptz, text, text, bigint, bigint, text
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.confirm_reward_refund_atomic(
    uuid, uuid, text, integer, text, text, bigint, boolean, bigint,
    timestamptz, text, text, bigint, bigint, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.prevent_confirmed_reward_refund_mutation TO service_role;
REVOKE EXECUTE ON FUNCTION public.prevent_confirmed_reward_refund_mutation FROM PUBLIC, anon, authenticated;
