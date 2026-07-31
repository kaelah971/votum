-- Recreate get_public_poll_results as SECURITY DEFINER so anon can call it
-- and access poll_votes aggregate counts without direct table SELECT.

DROP FUNCTION IF EXISTS public.get_public_poll_results(uuid);

CREATE OR REPLACE FUNCTION public.get_public_poll_results(_poll_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
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

GRANT EXECUTE ON FUNCTION public.get_public_poll_results(uuid) TO anon, authenticated, service_role;
