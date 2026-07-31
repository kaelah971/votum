-- Poll votes foundation: table, RLS, atomic voting function, and public results.
-- enforces one-wallet-one-vote via UNIQUE(poll_id, voter_wallet).

-- ============================================================================
-- TABLE
-- ============================================================================

CREATE TABLE public.poll_votes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    poll_id       uuid NOT NULL REFERENCES public.polls(id) ON DELETE CASCADE,
    option_id     uuid NOT NULL REFERENCES public.poll_options(id) ON DELETE CASCADE,
    voter_wallet  text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT poll_votes_one_per_wallet UNIQUE (poll_id, voter_wallet)
);

CREATE INDEX idx_poll_votes_poll ON public.poll_votes (poll_id);
CREATE INDEX idx_poll_votes_option ON public.poll_votes (option_id);

-- ============================================================================
-- RLS — no public access; service_role only
-- ============================================================================

ALTER TABLE public.poll_votes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.poll_votes FROM anon, authenticated;

-- ============================================================================
-- ATOMIC VOTE FUNCTION — service_role only
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cast_poll_vote_atomic(
    _poll_id       uuid,
    _option_id     uuid,
    _voter_wallet  text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    _lock_key   bigint;
    _hex        text;
    _i          int;
    _ch         text;
    _digit      int;
    _poll       record;
    _existing   record;
    _vote_id    uuid;
BEGIN
    -- Advisory lock: serialize per poll+voter
    _hex := replace(_poll_id::text, '-', '') || replace(_voter_wallet, 'x', '0');
    _lock_key := 0;
    FOR _i IN 1..15 LOOP
        _ch := lower(substr(_hex, _i, 1));
        _digit := CASE _ch
            WHEN '0' THEN 0 WHEN '1' THEN 1 WHEN '2' THEN 2
            WHEN '3' THEN 3 WHEN '4' THEN 4 WHEN '5' THEN 5
            WHEN '6' THEN 6 WHEN '7' THEN 7 WHEN '8' THEN 8
            WHEN '9' THEN 9 WHEN 'a' THEN 10 WHEN 'b' THEN 11
            WHEN 'c' THEN 12 WHEN 'd' THEN 13 WHEN 'e' THEN 14
            WHEN 'f' THEN 15 ELSE 0
        END;
        _lock_key := _lock_key * 16 + _digit;
    END LOOP;
    IF _lock_key = 0 THEN _lock_key := 1; END IF;
    PERFORM pg_advisory_xact_lock(_lock_key);

    -- Load and validate poll
    SELECT id, status, is_public, starts_at, ends_at
    INTO _poll
    FROM public.polls
    WHERE id = _poll_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'poll_not_found');
    END IF;

    IF _poll.status != 'live' THEN
        RETURN jsonb_build_object('result_kind', 'poll_not_open');
    END IF;

    IF _poll.starts_at IS NOT NULL AND _poll.starts_at > now() THEN
        RETURN jsonb_build_object('result_kind', 'poll_not_open');
    END IF;

    IF _poll.ends_at <= now() THEN
        RETURN jsonb_build_object('result_kind', 'poll_not_open');
    END IF;

    -- Validate option belongs to this poll
    IF NOT EXISTS (
        SELECT 1 FROM public.poll_options
        WHERE id = _option_id AND poll_id = _poll_id
    ) THEN
        RETURN jsonb_build_object('result_kind', 'invalid_option');
    END IF;

    -- Check existing vote
    SELECT id, option_id INTO _existing
    FROM public.poll_votes
    WHERE poll_id = _poll_id AND voter_wallet = _voter_wallet;

    IF FOUND THEN
        IF _existing.option_id = _option_id THEN
            RETURN jsonb_build_object(
                'vote_id', _existing.id,
                'poll_id', _poll_id,
                'option_id', _option_id,
                'result_kind', 'replay'
            );
        ELSE
            RETURN jsonb_build_object(
                'vote_id', _existing.id,
                'poll_id', _poll_id,
                'option_id', _existing.option_id,
                'result_kind', 'already_voted'
            );
        END IF;
    END IF;

    -- Insert vote
    INSERT INTO public.poll_votes (poll_id, option_id, voter_wallet)
    VALUES (_poll_id, _option_id, _voter_wallet)
    RETURNING id INTO _vote_id;

    RETURN jsonb_build_object(
        'vote_id', _vote_id,
        'poll_id', _poll_id,
        'option_id', _option_id,
        'created_at', now(),
        'result_kind', 'created'
    );
END;
$$;

-- ============================================================================
-- PUBLIC RESULTS FUNCTION — anon-safe aggregate only
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_public_poll_results(_poll_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    _poll       record;
    _opts       jsonb;
    _total      bigint;
BEGIN
    SELECT id, status, is_public, ends_at
    INTO _poll
    FROM public.polls
    WHERE id = _poll_id
      AND is_public = true
      AND status IN ('live', 'closed');

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result_kind', 'not_found');
    END IF;

    SELECT coalesce(sum(c), 0) INTO _total
    FROM (
        SELECT count(*) AS c FROM public.poll_votes WHERE poll_id = _poll_id
    ) sub;

    SELECT jsonb_agg(
        jsonb_build_object(
            'optionId', o.id,
            'label', o.label,
            'voteCount', coalesce(v.cnt, 0)
        )
        ORDER BY o.sort_order
    ) INTO _opts
    FROM public.poll_options o
    LEFT JOIN (
        SELECT option_id, count(*) AS cnt
        FROM public.poll_votes
        WHERE poll_id = _poll_id
        GROUP BY option_id
    ) v ON v.option_id = o.id
    WHERE o.poll_id = _poll_id;

    RETURN jsonb_build_object(
        'pollId', _poll_id,
        'status', _poll.status,
        'endsAt', _poll.ends_at,
        'totalVotes', _total,
        'options', coalesce(_opts, '[]'::jsonb)
    );
END;
$$;

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT INSERT ON public.poll_votes TO service_role;
GRANT SELECT ON public.poll_votes TO service_role;

GRANT EXECUTE ON FUNCTION public.cast_poll_vote_atomic TO service_role;
REVOKE EXECUTE ON FUNCTION public.cast_poll_vote_atomic FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_public_poll_results TO anon, authenticated, service_role;
