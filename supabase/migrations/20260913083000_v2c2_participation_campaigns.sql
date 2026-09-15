-- V2C.2C standalone Campaign product foundation.
-- This table contains product configuration only; settlement remains separate.

CREATE TABLE public.participation_campaigns (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    settlement_id                   uuid NOT NULL UNIQUE
        REFERENCES public.reward_settlements(id),
    owner_wallet                    text NOT NULL,
    campaign_type                   text NOT NULL,
    visibility                      text NOT NULL DEFAULT 'unlisted',
    title                           text NOT NULL,
    description                     text,
    status                          text NOT NULL DEFAULT 'draft',
    configuration_version           integer NOT NULL DEFAULT 1,
    published_configuration_version integer,
    starts_at                       timestamptz,
    ends_at                         timestamptz,
    close_reason                    text,
    configuration_locked_at         timestamptz,
    published_at                    timestamptz,
    closed_at                       timestamptz,
    created_at                      timestamptz NOT NULL DEFAULT now(),
    updated_at                      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT participation_campaigns_owner_wallet_shape CHECK (
        owner_wallet = lower(trim(owner_wallet))
        AND owner_wallet ~ '^[0-9a-f]{40}$'
    ),
    CONSTRAINT participation_campaigns_type CHECK (
        campaign_type IN ('public_giveaway', 'secret_drop', 'private_drop',
                          'event_drop', 'community_reward')
    ),
    CONSTRAINT participation_campaigns_visibility CHECK (
        visibility IN ('public', 'unlisted', 'private')
    ),
    CONSTRAINT participation_campaigns_status CHECK (
        status IN ('draft', 'published', 'closed', 'expired', 'cancelled')
    ),
    CONSTRAINT participation_campaigns_title_not_empty CHECK (
        length(trim(title)) BETWEEN 1 AND 160
    ),
    CONSTRAINT participation_campaigns_description_length CHECK (
        description IS NULL OR length(description) <= 4000
    ),
    CONSTRAINT participation_campaigns_version_positive CHECK (
        configuration_version > 0
    ),
    CONSTRAINT participation_campaigns_published_version_valid CHECK (
        published_configuration_version IS NULL
        OR published_configuration_version > 0
    ),
    CONSTRAINT participation_campaigns_window_valid CHECK (
        ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at
    ),
    CONSTRAINT participation_campaigns_close_reason_valid CHECK (
        close_reason IS NULL OR close_reason IN (
            'source_closed', 'elapsed', 'expired', 'creator_cancelled',
            'source_specific'
        )
    )
);

CREATE INDEX idx_participation_campaigns_owner
    ON public.participation_campaigns (owner_wallet);

CREATE INDEX idx_participation_campaigns_type_status
    ON public.participation_campaigns (campaign_type, status);

CREATE INDEX idx_participation_campaigns_public_window
    ON public.participation_campaigns (visibility, status, ends_at);

ALTER TABLE public.participation_campaigns ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.participation_campaigns FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.participation_campaigns TO service_role;
