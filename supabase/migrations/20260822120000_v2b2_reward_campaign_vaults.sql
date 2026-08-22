-- V2B.2.2B reward campaign vault persistence (additive only).
-- Dedicated private table for encrypted campaign vault material.
-- Keeps encrypted key material OUT of reward_campaigns (option B): the public
-- read path (get_public_reward_campaign) never touches this table, so no
-- ciphertext/IV/auth-tag can accidentally leak through a public query.
--
-- No plaintext private keys, no master key, no seed phrases are ever stored.
-- Exactly one vault per campaign (campaign_id PRIMARY KEY).

-- ============================================================================
-- REWARD CAMPAIGN VAULTS
-- ============================================================================

CREATE TABLE public.reward_campaign_vaults (
    campaign_id                  uuid PRIMARY KEY REFERENCES public.reward_campaigns(id),
    vault_address_hex            text NOT NULL,
    envelope_version             text NOT NULL,
    encryption_algorithm         text NOT NULL,
    encrypted_private_key_ciphertext text NOT NULL,
    encryption_iv                text NOT NULL,
    authentication_tag           text NOT NULL,
    created_at                   timestamptz NOT NULL DEFAULT now(),
    updated_at                   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reward_campaign_vaults_address_hex CHECK (
        vault_address_hex ~ '^[0-9a-f]{40}$'
    ),
    CONSTRAINT reward_campaign_vaults_version CHECK (
        envelope_version = 'votum:reward-vault:v1'
    ),
    CONSTRAINT reward_campaign_vaults_algorithm CHECK (
        encryption_algorithm = 'aes-256-gcm'
    ),
    CONSTRAINT reward_campaign_vaults_ciphertext_not_empty CHECK (
        length(trim(encrypted_private_key_ciphertext)) > 0
    ),
    CONSTRAINT reward_campaign_vaults_iv_not_empty CHECK (
        length(trim(encryption_iv)) > 0
    ),
    CONSTRAINT reward_campaign_vaults_tag_not_empty CHECK (
        length(trim(authentication_tag)) > 0
    )
);

-- ============================================================================
-- RLS — internal only. No anon/authenticated access; no DELETE grant.
-- ============================================================================

ALTER TABLE public.reward_campaign_vaults ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.reward_campaign_vaults FROM anon, authenticated;
GRANT SELECT, INSERT ON public.reward_campaign_vaults TO service_role;

-- ============================================================================
-- ATOMIC VAULT CREATION (advisory-lock SECURITY DEFINER RPC)
-- ============================================================================
-- Key generation + encryption happen server-side. This RPC only atomically
-- persists the first candidate envelope under an advisory lock, so two
-- concurrent ensureCampaignVault calls can never produce two active vaults:
-- the first insert wins; the loser resolves the persisted vault and discards
-- its candidate key.

CREATE OR REPLACE FUNCTION public.ensure_reward_campaign_vault_atomic(
    _campaign_id          uuid,
    _vault_address_hex    text,
    _envelope_version     text,
    _encryption_algorithm text,
    _ciphertext           text,
    _iv                   text,
    _auth_tag             text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    _lock_key bigint;
    _campaign record;
    _existing record;
BEGIN
    -- Deterministic advisory lock key from campaign id (repo pattern:
    -- first 15 hex chars of the stripped UUID, 60 bits, signed-bigint-safe).
    _lock_key := ('x' || substr(replace(_campaign_id::text, '-', ''), 1, 15))::bit(64)::bigint;
    IF _lock_key = 0 THEN
        _lock_key := 1;
    END IF;
    PERFORM pg_advisory_xact_lock(_lock_key);

    -- Campaign must exist and be in an allowed pre-funding state.
    SELECT * INTO _campaign
    FROM public.reward_campaigns
    WHERE id = _campaign_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'campaign_not_found');
    END IF;

    IF _campaign.status NOT IN ('configured', 'funding_pending') THEN
        RETURN jsonb_build_object('result_kind', 'campaign_state_invalid', 'state', _campaign.status);
    END IF;

    -- Existing vault? Return it (idempotent; do not create another key).
    SELECT * INTO _existing
    FROM public.reward_campaign_vaults
    WHERE campaign_id = _campaign_id;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'result_kind', 'existing',
            'vault_address_hex', _existing.vault_address_hex
        );
    END IF;

    -- Insert the first candidate atomically.
    INSERT INTO public.reward_campaign_vaults (
        campaign_id, vault_address_hex, envelope_version, encryption_algorithm,
        encrypted_private_key_ciphertext, encryption_iv, authentication_tag
    ) VALUES (
        _campaign_id, _vault_address_hex, _envelope_version, _encryption_algorithm,
        _ciphertext, _iv, _auth_tag
    )
    ON CONFLICT (campaign_id) DO NOTHING
    RETURNING vault_address_hex INTO _existing;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'result_kind', 'created',
            'vault_address_hex', _existing.vault_address_hex
        );
    END IF;

    -- Lost the race: return the already-persisted vault.
    SELECT * INTO _existing
    FROM public.reward_campaign_vaults
    WHERE campaign_id = _campaign_id;

    RETURN jsonb_build_object(
        'result_kind', 'existing',
        'vault_address_hex', _existing.vault_address_hex
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_reward_campaign_vault_atomic TO service_role;
REVOKE EXECUTE ON FUNCTION public.ensure_reward_campaign_vault_atomic FROM PUBLIC, anon, authenticated;
