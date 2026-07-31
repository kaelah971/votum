-- Creator intelligence: summary, per-poll performance, and activity feed.
-- Service_role only — no public access.

-- ============================================================================
-- FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_creator_intelligence(_creator_wallet text)
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
        'livePolls', count(*) FILTER (WHERE status = 'live' AND ends_at > _now),
        'closedPolls', count(*) FILTER (WHERE status = 'closed' OR (status = 'live' AND ends_at <= _now)),
        'totalVotes', coalesce(sum(v.vc), 0),
        'totalNimLuna', coalesce(sum(c.tl), 0)::text,
        'totalContributions', coalesce(sum(c.tc), 0),
        'averageVotesPerPoll',
            CASE WHEN count(*) > 0
                THEN round((coalesce(sum(v.vc), 0))::numeric / count(*)::numeric, 1)
                ELSE 0 END,
        'averageNimLunaPerPoll',
            CASE WHEN count(*) > 0
                THEN (coalesce(sum(c.tl), 0) / count(*))::text
                ELSE '0' END
    ) INTO _summary
    FROM public.polls p
    LEFT JOIN LATERAL (
        SELECT count(*) AS vc FROM public.poll_votes WHERE poll_id = p.id
    ) v ON true
    LEFT JOIN LATERAL (
        SELECT coalesce(sum(amount_luna), 0) AS tl, count(*) AS tc
        FROM public.nim_contributions WHERE poll_id = p.id
    ) c ON true
    WHERE p.creator_wallet = _creator_wallet;

    -- ── Per-poll performance ───────────────────────────────────────────
    SELECT jsonb_agg(
        jsonb_build_object(
            'id', p.id,
            'question', p.question,
            'status',
                CASE WHEN p.status = 'live' AND p.ends_at > _now THEN 'live'
                     WHEN p.status = 'closed' OR (p.status = 'live' AND p.ends_at <= _now) THEN 'closed'
                     ELSE p.status END,
            'createdAt', p.created_at,
            'endsAt', p.ends_at,
            'totalVotes', coalesce(v.vc, 0),
            'totalNimLuna', coalesce(c.tl, 0)::text,
            'contributionCount', coalesce(c.tc, 0),
            'options', coalesce(opt.data, '[]'::jsonb)
        )
        ORDER BY p.created_at DESC
    ) INTO _polls
    FROM public.polls p
    LEFT JOIN LATERAL (
        SELECT count(*) AS vc FROM public.poll_votes WHERE poll_id = p.id
    ) v ON true
    LEFT JOIN LATERAL (
        SELECT coalesce(sum(amount_luna), 0) AS tl, count(*) AS tc
        FROM public.nim_contributions WHERE poll_id = p.id
    ) c ON true
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(
            jsonb_build_object(
                'optionId', o.id,
                'label', o.label,
                'voteCount', coalesce(ov.vc, 0),
                'nimLuna', coalesce(oc.tl, 0)::text,
                'contributionCount', coalesce(oc.tc, 0)
            )
            ORDER BY o.sort_order
        ) AS data
        FROM public.poll_options o
        LEFT JOIN LATERAL (
            SELECT count(*) AS vc FROM public.poll_votes WHERE option_id = o.id
        ) ov ON true
        LEFT JOIN LATERAL (
            SELECT coalesce(sum(amount_luna), 0) AS tl, count(*) AS tc
            FROM public.nim_contributions WHERE option_id = o.id
        ) oc ON true
        WHERE o.poll_id = p.id
    ) opt ON true
    WHERE p.creator_wallet = _creator_wallet;

    -- ── Recent activity ────────────────────────────────────────────────
    WITH activity AS (
        -- Published polls
        SELECT
            'poll_published' AS type,
            id AS poll_id,
            question AS poll_question,
            NULL::uuid AS option_id,
            NULL::text AS option_label,
            NULL::text AS amount_luna,
            created_at AS occurred_at
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
        JOIN public.polls p ON p.id = pv.poll_id AND p.creator_wallet = _creator_wallet
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
        JOIN public.polls p ON p.id = nc.poll_id AND p.creator_wallet = _creator_wallet
        JOIN public.poll_options po ON po.id = nc.option_id

        UNION ALL

        -- Polls closed (recently)
        SELECT
            'poll_closed' AS type,
            id AS poll_id,
            question AS poll_question,
            NULL::uuid AS option_id,
            NULL::text AS option_label,
            NULL::text AS amount_luna,
            ends_at AS occurred_at
        FROM public.polls
        WHERE creator_wallet = _creator_wallet
          AND (status = 'closed' OR (status = 'live' AND ends_at <= _now))
    )
    SELECT jsonb_agg(activity_data)
    INTO _activity
    FROM (
        SELECT jsonb_build_object(
            'id', gen_random_uuid()::text,
            'type', a.type,
            'pollId', a.poll_id,
            'pollQuestion', a.poll_question,
            'optionId', a.option_id,
            'optionLabel', a.option_label,
            'amountLuna', a.amount_luna,
            'occurredAt', a.occurred_at
        ) AS activity_data,
        a.occurred_at
        FROM activity a
        ORDER BY a.occurred_at DESC
        LIMIT 50
    ) sub;

    RETURN jsonb_build_object(
        'summary', coalesce(_summary, '{}'::jsonb),
        'polls', coalesce(_polls, '[]'::jsonb),
        'activity', coalesce(_activity, '[]'::jsonb)
    );
END;
$$;

-- ============================================================================
-- GRANTS
-- ============================================================================

GRANT EXECUTE ON FUNCTION public.get_creator_intelligence TO service_role;
REVOKE EXECUTE ON FUNCTION public.get_creator_intelligence FROM PUBLIC, anon, authenticated;
