-- Votum Poll Foundation
-- Creates the core poll infrastructure with RLS for public read-only access.

-- ============================================================================
-- TABLES
-- ============================================================================

CREATE TABLE public.polls (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_wallet      text NOT NULL,
    question            text NOT NULL,
    description         text,
    mode                text NOT NULL,
    destination_wallet  text NOT NULL,
    destination_purpose text NOT NULL,
    min_nim_luna        bigint NOT NULL,
    fairness_mode       text NOT NULL DEFAULT 'one_wallet_one_vote',
    status              text NOT NULL DEFAULT 'draft',
    starts_at           timestamptz,
    ends_at             timestamptz NOT NULL,
    is_public           boolean NOT NULL DEFAULT false,
    published_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT polls_question_length CHECK (
        length(trim(question)) BETWEEN 10 AND 200
    ),
    CONSTRAINT polls_description_length CHECK (
        description IS NULL OR length(description) <= 2000
    ),
    CONSTRAINT polls_mode_values CHECK (
        mode IN ('creator_support', 'community_support')
    ),
    CONSTRAINT polls_destination_wallet_not_empty CHECK (
        length(trim(destination_wallet)) > 0
    ),
    CONSTRAINT polls_destination_purpose_not_empty CHECK (
        length(trim(destination_purpose)) > 0
    ),
    CONSTRAINT polls_min_nim_luna_positive CHECK (
        min_nim_luna > 0
    ),
    CONSTRAINT polls_fairness_mode CHECK (
        fairness_mode = 'one_wallet_one_vote'
    ),
    CONSTRAINT polls_status_values CHECK (
        status IN ('draft', 'live', 'closed', 'cancelled')
    ),
    CONSTRAINT polls_ends_after_starts CHECK (
        starts_at IS NULL OR ends_at > starts_at
    )
);

CREATE TABLE public.poll_options (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    poll_id     uuid NOT NULL REFERENCES public.polls(id) ON DELETE CASCADE,
    label       text NOT NULL,
    sort_order  smallint NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT poll_options_label_not_empty CHECK (
        length(trim(label)) > 0
    ),
    CONSTRAINT poll_options_label_max_length CHECK (
        length(label) <= 120
    ),
    CONSTRAINT poll_options_sort_order_range CHECK (
        sort_order BETWEEN 0 AND 5
    ),
    CONSTRAINT poll_options_unique_sort_order UNIQUE (poll_id, sort_order)
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Public poll discovery: most recently published first
CREATE INDEX idx_polls_public_status_created
    ON public.polls (status, created_at DESC)
    WHERE is_public = true;

-- Closing soon for live public polls
CREATE INDEX idx_polls_public_status_ends
    ON public.polls (status, ends_at)
    WHERE is_public = true;

-- Future creator queries by wallet
CREATE INDEX idx_polls_creator_wallet
    ON public.polls (creator_wallet, created_at DESC);

-- Duplicate option detection per poll
CREATE UNIQUE INDEX idx_poll_options_unique_label
    ON public.poll_options (poll_id, lower(trim(label)));

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poll_options ENABLE ROW LEVEL SECURITY;

-- Public read: only published live or closed polls
CREATE POLICY polls_public_read ON public.polls
    FOR SELECT
    USING (is_public = true AND status IN ('live', 'closed'));

-- Public read: options belonging to publicly readable polls only
CREATE POLICY poll_options_public_read ON public.poll_options
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.polls
            WHERE polls.id = poll_options.poll_id
              AND polls.is_public = true
              AND polls.status IN ('live', 'closed')
        )
    );

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT SELECT ON public.polls TO anon, authenticated;
GRANT SELECT ON public.poll_options TO anon, authenticated;

-- Explicitly deny write access for anon and authenticated
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.polls FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.poll_options FROM anon, authenticated;
