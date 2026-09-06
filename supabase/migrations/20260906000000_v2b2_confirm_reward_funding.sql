-- V2B.2.5 Phase B — atomically confirm server-observed reward funding.
--
-- The caller is the server-only reconciliation boundary. It supplies the
-- already-observed amount and block metadata; the RPC never accepts a client
-- confirmation flag or client economic terms. No reward/payout/refund rows are
-- created here.

CREATE OR REPLACE FUNCTION public.confirm_reward_funding_atomic(
    _campaign_id             uuid,
    _intent_id               uuid,
    _transaction_hash        text,
    _observed_amount_luna    bigint,
    _block_number            bigint DEFAULT NULL,
    _transaction_timestamp   timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    _campaign record;
    _funding record;
    _vault record;
    _hash text;
    _required_amount bigint;
    _excess bigint;
    _funded_at timestamptz;
    _confirmed_at timestamptz;
BEGIN
    _hash := lower(trim(COALESCE(_transaction_hash, '')));
    IF _hash !~ '^[0-9a-f]{64}$' THEN
        RETURN jsonb_build_object('result_kind', 'invalid_hash');
    END IF;

    IF _observed_amount_luna IS NULL OR _observed_amount_luna < 0 THEN
        RETURN jsonb_build_object('result_kind', 'invalid_amount');
    END IF;

    -- Lock order is campaign first, funding second, matching begin/bind and
    -- making concurrent confirmations for one campaign serialize.
    SELECT c.* INTO _campaign
    FROM public.reward_campaigns c
    WHERE c.id = _campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;

    SELECT f.* INTO _funding
    FROM public.reward_funding_transactions f
    WHERE f.id = _intent_id
      AND f.campaign_id = _campaign_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'intent_not_found');
    END IF;

    -- A replay is authoritative and side-effect free. A different intent or
    -- hash can never add a second economic transition to an already funded
    -- campaign.
    IF _campaign.status <> 'funding_pending' THEN
        IF _campaign.status IN ('funded', 'rewarding', 'exhausted', 'closed', 'refunding', 'refunded')
           AND _funding.status = 'confirmed'
           AND lower(COALESCE(_funding.confirmed_transaction_hash, '')) = _hash THEN
            RETURN jsonb_build_object(
                'result_kind', 'replay',
                'campaign_id', _campaign.id,
                'intent_id', _funding.id,
                'transaction_hash', _funding.confirmed_transaction_hash,
                'required_amount_luna', _campaign.total_budget_luna::text,
                'observed_amount_luna', _campaign.funded_amount_luna::text,
                'refundable_excess_luna', _campaign.refundable_excess_luna::text,
                'funded_at', _campaign.funded_at,
                'confirmed_at', _funding.confirmed_at
            );
        END IF;
        RETURN jsonb_build_object(
            'result_kind', 'campaign_state_conflict',
            'state', _campaign.status
        );
    END IF;

    IF _funding.status <> 'submitted' THEN
        RETURN jsonb_build_object(
            'result_kind', 'intent_state_conflict',
            'state', _funding.status
        );
    END IF;

    IF _funding.submitted_transaction_hash IS NULL THEN
        RETURN jsonb_build_object('result_kind', 'intent_unbound');
    END IF;

    IF lower(_funding.submitted_transaction_hash) <> _hash THEN
        RETURN jsonb_build_object('result_kind', 'hash_mismatch');
    END IF;

    SELECT v.vault_address_hex INTO _vault
    FROM public.reward_campaign_vaults v
    WHERE v.campaign_id = _campaign_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'vault_missing');
    END IF;

    IF _funding.vault_wallet IS NULL
       OR lower(_funding.vault_wallet) <> lower(_vault.vault_address_hex)
       OR (_campaign.vault_wallet IS NOT NULL
           AND lower(_campaign.vault_wallet) <> lower(_vault.vault_address_hex)) THEN
        RETURN jsonb_build_object('result_kind', 'vault_mismatch');
    END IF;

    _required_amount := _campaign.total_budget_luna;
    IF _funding.amount_luna <> _required_amount
       OR _funding.reward_principal_luna IS DISTINCT FROM _campaign.reward_principal_luna
       OR _funding.fee_reserve_luna IS DISTINCT FROM _campaign.fee_reserve_luna THEN
        RETURN jsonb_build_object('result_kind', 'funding_terms_mismatch');
    END IF;

    IF _observed_amount_luna < _required_amount THEN
        RETURN jsonb_build_object(
            'result_kind', 'amount_underpaid',
            'required_amount_luna', _required_amount::text,
            'observed_amount_luna', _observed_amount_luna::text
        );
    END IF;

    _excess := _observed_amount_luna - _required_amount;
    _confirmed_at := now();

    UPDATE public.reward_funding_transactions
    SET status = 'confirmed',
        confirmed_transaction_hash = _hash,
        block_number = _block_number,
        transaction_timestamp = _transaction_timestamp,
        confirmed_at = _confirmed_at,
        updated_at = _confirmed_at
    WHERE id = _funding.id;

    UPDATE public.reward_campaigns
    SET status = 'funded',
        funded_amount_luna = _observed_amount_luna,
        refundable_excess_luna = _excess,
        funded_at = _confirmed_at,
        updated_at = _confirmed_at
    WHERE id = _campaign.id;

    SELECT funded_at INTO _funded_at
    FROM public.reward_campaigns
    WHERE id = _campaign.id;

    RETURN jsonb_build_object(
        'result_kind', 'confirmed',
        'campaign_id', _campaign.id,
        'intent_id', _funding.id,
        'transaction_hash', _hash,
        'required_amount_luna', _required_amount::text,
        'observed_amount_luna', _observed_amount_luna::text,
        'refundable_excess_luna', _excess::text,
        'funded_at', _funded_at,
        'confirmed_at', _confirmed_at
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_reward_funding_atomic(
    uuid, uuid, text, bigint, bigint, timestamptz
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.confirm_reward_funding_atomic(
    uuid, uuid, text, bigint, bigint, timestamptz
) FROM PUBLIC, anon, authenticated;
