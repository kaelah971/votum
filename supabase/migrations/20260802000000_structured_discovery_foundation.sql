-- Votum V2A.1 — Structured Discovery foundation
-- Adds category and format taxonomy columns to public.polls.
-- Backfills existing polls as communities + decision.
-- Updates publish_poll_atomic (backward-compatible) and
-- get_creator_intelligence to include category / format.
-- Adds partial discovery indexes.
--
-- Additive only.  No destructive changes.  No ENUM types.  No lookup tables.

-- ============================================================================
-- 1. Add category and format columns
-- ============================================================================

ALTER TABLE public.polls
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'communities';

ALTER TABLE public.polls
  ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'decision';

-- ---------------------------------------------------------------------------
-- Guarded backfill — ensures every existing row has a safe value even
-- if the column was initially created nullable during development.
-- ---------------------------------------------------------------------------
UPDATE public.polls
   SET category = 'communities'
 WHERE category IS NULL OR category = '';

UPDATE public.polls
   SET format = 'decision'
 WHERE format IS NULL OR format = '';

-- ---------------------------------------------------------------------------
-- Harden column state — ensures the defaults and NOT NULL are enforced
-- even when ADD COLUMN IF NOT EXISTS skipped a pre-existing column.
-- ---------------------------------------------------------------------------
ALTER TABLE public.polls ALTER COLUMN category SET DEFAULT 'communities';
ALTER TABLE public.polls ALTER COLUMN format   SET DEFAULT 'decision';

-- SET NOT NULL must be guarded because ALTER COLUMN does not support
-- IF NOT EXISTS and will fail if the column is already NOT NULL.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'polls'
       AND column_name  = 'category'
       AND is_nullable  = 'YES'
  ) THEN
    ALTER TABLE public.polls ALTER COLUMN category SET NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'polls'
       AND column_name  = 'format'
       AND is_nullable  = 'YES'
  ) THEN
    ALTER TABLE public.polls ALTER COLUMN format SET NOT NULL;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Verify backfill before adding CHECK constraints.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.polls WHERE category IS NULL) THEN
    RAISE EXCEPTION 'Backfill failed — NULL categories remain';
  END IF;
  IF EXISTS (SELECT 1 FROM public.polls WHERE format IS NULL) THEN
    RAISE EXCEPTION 'Backfill failed — NULL formats remain';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- CHECK constraints — guarded so re-application does not fail.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'polls_category_check'
       AND conrelid = 'public.polls'::regclass
  ) THEN
    ALTER TABLE public.polls
      ADD CONSTRAINT polls_category_check
        CHECK (category IN ('sports', 'entertainment', 'brands_products',
                            'communities', 'other'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'polls_format_check'
       AND conrelid = 'public.polls'::regclass
  ) THEN
    ALTER TABLE public.polls
      ADD CONSTRAINT polls_format_check
        CHECK (format IN ('decision', 'prediction', 'fan_vote',
                          'ranking', 'nomination', 'audience_choice'));
  END IF;
END;
$$;

-- ============================================================================
-- 2. Discovery indexes (partial — only public polls)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_polls_public_category_status_ends
    ON public.polls (category, status, ends_at)
    WHERE is_public = true;

CREATE INDEX IF NOT EXISTS idx_polls_public_format_status_created
    ON public.polls (format, status, created_at DESC)
    WHERE is_public = true;

-- ============================================================================
-- 3. publish_poll_atomic — backward-compatible replacement
-- ============================================================================

-- Drop the original 11-param signature that predates the hardening
-- migration.  It lacks _request_fingerprint and is broken against
-- the NOT NULL poll_publication_requests.request_fingerprint column.
DROP FUNCTION IF EXISTS public.publish_poll_atomic(
    text, text, text, text, text, text, bigint, text, timestamptz,
    text[], uuid
);

-- Drop the old 12-param signature so old callers resolve to the new
-- 14-param function via defaults (avoids ambiguous overload).
DROP FUNCTION IF EXISTS public.publish_poll_atomic(
    text, text, text, text, text, text, bigint, text, timestamptz,
    text[], uuid, text
);

CREATE OR REPLACE FUNCTION public.publish_poll_atomic(
    _creator_wallet       text,
    _question             text,
    _description          text,
    _mode                 text,
    _destination_wallet   text,
    _destination_purpose  text,
    _min_nim_luna         bigint,
    _fairness_mode        text,
    _ends_at              timestamptz,
    _options              text[],
    _idempotency_key      uuid,
    _request_fingerprint  text,
    _category             text DEFAULT 'communities',
    _format               text DEFAULT 'decision'
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    _now        timestamptz := now();
    _lock_key   bigint;
    _hex        text;
    _i          int;
    _ch         text;
    _digit      int;
    _existing   record;
    _poll_id    uuid;
    _opt_label  text;
    _idx        int;
BEGIN
    -- Advisory lock: serialize per-creator+key
    _hex := replace(_idempotency_key::text, '-', '');
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

    -- Check existing publication request
    SELECT poll_id, request_fingerprint INTO _existing
    FROM public.poll_publication_requests
    WHERE creator_wallet = _creator_wallet
      AND idempotency_key = _idempotency_key;

    IF FOUND THEN
        IF _existing.request_fingerprint = _request_fingerprint THEN
            RETURN jsonb_build_object(
                'id', _existing.poll_id,
                'status', (SELECT status FROM public.polls
                            WHERE id = _existing.poll_id),
                'result_kind', 'replay'
            );
        ELSE
            RETURN jsonb_build_object(
                'id', null,
                'status', null,
                'result_kind', 'conflict'
            );
        END IF;
    END IF;

    -- Validate options
    IF array_length(_options, 1) < 2 THEN
        RAISE EXCEPTION 'At least 2 options are required'
            USING ERRCODE = 'check_violation';
    END IF;

    IF array_length(_options, 1) > 6 THEN
        RAISE EXCEPTION 'Maximum 6 options allowed'
            USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT count(DISTINCT lower(trim(opt)))
          FROM unnest(_options) opt)
       <> array_length(_options, 1) THEN
        RAISE EXCEPTION 'Duplicate option labels are not allowed'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Insert poll
    INSERT INTO public.polls (
        creator_wallet, question, description, mode,
        destination_wallet, destination_purpose,
        min_nim_luna, fairness_mode,
        status, starts_at, ends_at,
        is_public, published_at,
        created_at, updated_at,
        category, format
    ) VALUES (
        _creator_wallet, trim(_question),
        CASE WHEN _description IS NOT NULL
              AND length(trim(_description)) > 0
             THEN trim(_description) ELSE NULL END,
        _mode,
        _destination_wallet, trim(_destination_purpose),
        _min_nim_luna, _fairness_mode,
        'live', _now, _ends_at,
        true, _now,
        _now, _now,
        _category, _format
    )
    RETURNING id INTO _poll_id;

    -- Insert options
    _idx := 0;
    FOREACH _opt_label IN ARRAY _options LOOP
        INSERT INTO public.poll_options (poll_id, label, sort_order)
        VALUES (_poll_id, trim(_opt_label), _idx);
        _idx := _idx + 1;
    END LOOP;

    -- Record idempotency
    INSERT INTO public.poll_publication_requests
        (creator_wallet, idempotency_key, poll_id, request_fingerprint)
    VALUES (_creator_wallet, _idempotency_key, _poll_id, _request_fingerprint);

    RETURN jsonb_build_object(
        'id', _poll_id,
        'status', 'live',
        'result_kind', 'created'
    );
END;
$$;

-- Preserve service_role-only execution
GRANT EXECUTE ON FUNCTION public.publish_poll_atomic(
    text, text, text, text, text, text, bigint, text, timestamptz,
    text[], uuid, text, text, text
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.publish_poll_atomic(
    text, text, text, text, text, text, bigint, text, timestamptz,
    text[], uuid, text, text, text
) FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 4. get_creator_intelligence — add category / format to poll objects
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_creator_intelligence(
    _creator_wallet text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    _summary   jsonb;
    _polls     jsonb;
    _activity  jsonb;
    _now       timestamptz := now();
BEGIN
    -- ── Summary metrics ────────────────────────────────────────────────
    SELECT jsonb_build_object(
        'totalPolls', count(*),
        'livePolls', count(*) FILTER (
            WHERE status = 'live' AND ends_at > _now),
        'closedPolls', count(*) FILTER (
            WHERE status = 'closed'
               OR (status = 'live' AND ends_at <= _now)),
        'totalVotes', coalesce(sum(v.vc), 0),
        'totalNimLuna', coalesce(sum(c.tl), 0)::text,
        'totalContributions', coalesce(sum(c.tc), 0),
        'averageVotesPerPoll',
            CASE WHEN count(*) > 0
                THEN round((coalesce(sum(v.vc), 0))::numeric
                            / count(*)::numeric, 1)
                ELSE 0 END,
        'averageNimLunaPerPoll',
            CASE WHEN count(*) > 0
                THEN (coalesce(sum(c.tl), 0) / count(*))::text
                ELSE '0' END
    ) INTO _summary
    FROM public.polls p
    LEFT JOIN LATERAL (
        SELECT count(*) AS vc
          FROM public.poll_votes
         WHERE poll_id = p.id
    ) v ON true
    LEFT JOIN LATERAL (
        SELECT coalesce(sum(amount_luna), 0) AS tl,
               count(*) AS tc
          FROM public.nim_contributions
         WHERE poll_id = p.id
    ) c ON true
    WHERE p.creator_wallet = _creator_wallet;

    -- ── Per-poll performance ───────────────────────────────────────────
    SELECT jsonb_agg(
        jsonb_build_object(
            'id',        p.id,
            'question',  p.question,
            'status',
                CASE WHEN p.status = 'live' AND p.ends_at > _now THEN 'live'
                     WHEN p.status = 'closed'
                       OR (p.status = 'live' AND p.ends_at <= _now) THEN 'closed'
                     ELSE p.status END,
            'category',  p.category,
            'format',    p.format,
            'createdAt', p.created_at,
            'endsAt',    p.ends_at,
            'totalVotes',       coalesce(v.vc, 0),
            'totalNimLuna',      coalesce(c.tl, 0)::text,
            'contributionCount', coalesce(c.tc, 0),
            'options',  coalesce(opt.data, '[]'::jsonb)
        )
        ORDER BY p.created_at DESC
    ) INTO _polls
    FROM public.polls p
    LEFT JOIN LATERAL (
        SELECT count(*) AS vc
          FROM public.poll_votes
         WHERE poll_id = p.id
    ) v ON true
    LEFT JOIN LATERAL (
        SELECT coalesce(sum(amount_luna), 0) AS tl,
               count(*) AS tc
          FROM public.nim_contributions
         WHERE poll_id = p.id
    ) c ON true
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(
            jsonb_build_object(
                'optionId',         o.id,
                'label',            o.label,
                'voteCount',        coalesce(ov.vc, 0),
                'nimLuna',          coalesce(oc.tl, 0)::text,
                'contributionCount', coalesce(oc.tc, 0)
            )
            ORDER BY o.sort_order
        ) AS data
        FROM public.poll_options o
        LEFT JOIN LATERAL (
            SELECT count(*) AS vc
              FROM public.poll_votes
             WHERE option_id = o.id
        ) ov ON true
        LEFT JOIN LATERAL (
            SELECT coalesce(sum(amount_luna), 0) AS tl,
                   count(*) AS tc
              FROM public.nim_contributions
             WHERE option_id = o.id
        ) oc ON true
        WHERE o.poll_id = p.id
    ) opt ON true
    WHERE p.creator_wallet = _creator_wallet;

    -- ── Recent activity ────────────────────────────────────────────────
    WITH activity AS (
        -- Published polls
        SELECT
            'poll_published' AS type,
            id        AS poll_id,
            question  AS poll_question,
            NULL::uuid  AS option_id,
            NULL::text  AS option_label,
            NULL::text  AS amount_luna,
            created_at  AS occurred_at
        FROM public.polls
        WHERE creator_wallet = _creator_wallet

        UNION ALL

        -- Votes received
        SELECT
            'vote_received' AS type,
            pv.poll_id,
            p.question AS poll_question,
            pv.option_id,
            po.label AS option_label,
            NULL::text AS amount_luna,
            pv.created_at AS occurred_at
        FROM public.poll_votes pv
        JOIN public.polls p
          ON p.id = pv.poll_id
         AND p.creator_wallet = _creator_wallet
        JOIN public.poll_options po ON po.id = pv.option_id

        UNION ALL

        -- NIM support confirmed
        SELECT
            'nim_support_confirmed' AS type,
            nc.poll_id,
            p.question AS poll_question,
            nc.option_id,
            po.label AS option_label,
            nc.amount_luna::text AS amount_luna,
            nc.confirmed_at AS occurred_at
        FROM public.nim_contributions nc
        JOIN public.polls p
          ON p.id = nc.poll_id
         AND p.creator_wallet = _creator_wallet
        JOIN public.poll_options po ON po.id = nc.option_id

        UNION ALL

        -- Polls closed (recently)
        SELECT
            'poll_closed' AS type,
            id        AS poll_id,
            question  AS poll_question,
            NULL::uuid  AS option_id,
            NULL::text  AS option_label,
            NULL::text  AS amount_luna,
            ends_at     AS occurred_at
        FROM public.polls
        WHERE creator_wallet = _creator_wallet
          AND (status = 'closed'
               OR (status = 'live' AND ends_at <= _now))
    )
    SELECT jsonb_agg(activity_data)
    INTO _activity
    FROM (
        SELECT jsonb_build_object(
            'id',           gen_random_uuid()::text,
            'type',         a.type,
            'pollId',       a.poll_id,
            'pollQuestion', a.poll_question,
            'optionId',     a.option_id,
            'optionLabel',  a.option_label,
            'amountLuna',   a.amount_luna,
            'occurredAt',   a.occurred_at
        ) AS activity_data,
        a.occurred_at
        FROM activity a
        ORDER BY a.occurred_at DESC
        LIMIT 50
    ) sub;

    RETURN jsonb_build_object(
        'summary',  coalesce(_summary,  '{}'::jsonb),
        'polls',    coalesce(_polls,    '[]'::jsonb),
        'activity', coalesce(_activity, '[]'::jsonb)
    );
END;
$$;

-- Preserve service_role-only execution
GRANT EXECUTE ON FUNCTION public.get_creator_intelligence
    TO service_role;
REVOKE EXECUTE ON FUNCTION public.get_creator_intelligence
    FROM PUBLIC, anon, authenticated;
