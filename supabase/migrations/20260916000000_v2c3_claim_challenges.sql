-- V2C.3C one-time claim authorization challenges for Public Giveaway claims.
--
-- Server-private storage for the signed Claim NIM intent. Each row binds one
-- exact Campaign to one canonical claimant wallet with a single-use nonce
-- (stored as a SHA-256 hash; the raw nonce is never persisted), the claim
-- action/version, and a bounded lifetime. Challenge verification happens in
-- application code; authoritative consumption happens only inside the future
-- atomic claim reservation transaction, which sets consumed_at in the same
-- commit as the entitlement. This slice performs no financial writes and
-- consumes no challenge.

CREATE TABLE public.campaign_claim_challenges (
    id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id                  uuid NOT NULL
        REFERENCES public.participation_campaigns(id) ON DELETE CASCADE,
    participant_wallet           text NOT NULL,
    nonce_hash                   text NOT NULL,
    action                       text NOT NULL DEFAULT 'campaign_claim',
    version                      integer NOT NULL DEFAULT 1,
    message                      text NOT NULL,
    issued_at                    timestamptz NOT NULL DEFAULT now(),
    expires_at                   timestamptz NOT NULL,
    consumed_at                  timestamptz,
    created_at                   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT campaign_claim_challenges_wallet_shape CHECK (
        participant_wallet = lower(trim(participant_wallet))
        AND participant_wallet ~ '^[0-9a-f]{40}$'
    ),
    CONSTRAINT campaign_claim_challenges_nonce_hash_not_empty CHECK (
        length(trim(nonce_hash)) > 0
    ),
    CONSTRAINT campaign_claim_challenges_action CHECK (
        action = 'campaign_claim'
    ),
    CONSTRAINT campaign_claim_challenges_version CHECK (
        version = 1
    ),
    CONSTRAINT campaign_claim_challenges_message_not_empty CHECK (
        length(trim(message)) > 0
    ),
    CONSTRAINT campaign_claim_challenges_expires_after_issued CHECK (
        expires_at > issued_at
    )
);

CREATE INDEX idx_campaign_claim_challenges_campaign
    ON public.campaign_claim_challenges (campaign_id);
CREATE INDEX idx_campaign_claim_challenges_wallet_expires
    ON public.campaign_claim_challenges (participant_wallet, expires_at);
CREATE INDEX idx_campaign_claim_challenges_unused
    ON public.campaign_claim_challenges (participant_wallet, expires_at)
    WHERE consumed_at IS NULL;

ALTER TABLE public.campaign_claim_challenges ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.campaign_claim_challenges FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_claim_challenges TO service_role;
