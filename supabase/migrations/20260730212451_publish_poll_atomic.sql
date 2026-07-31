-- Atomic poll publication: idempotency table + PL/pgSQL function.
-- Grants service_role only — no public write access.

-- ============================================================================
-- Idempotency table
-- ============================================================================

CREATE TABLE public.poll_publication_requests (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_wallet   text NOT NULL,
    idempotency_key  uuid NOT NULL,
    poll_id          uuid NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT poll_publication_requests_unique
        UNIQUE (creator_wallet, idempotency_key)
);

-- ============================================================================
-- RLS — disabled for public roles
-- ============================================================================

ALTER TABLE public.poll_publication_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.poll_publication_requests FROM anon, authenticated;

-- ============================================================================
-- Atomic publish function (service_role only)
-- ============================================================================

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
    _idempotency_key      uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    _now        timestamptz := now();
    _existing   uuid;
    _poll_id    uuid;
    _opt_label  text;
    _idx        int;
BEGIN
    -- Resolve idempotency: return existing poll if already published
    SELECT poll_id INTO _existing
    FROM public.poll_publication_requests
    WHERE creator_wallet = _creator_wallet
      AND idempotency_key = _idempotency_key;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'id', _existing,
            'status', (SELECT status FROM public.polls WHERE id = _existing),
            'replay', true
        );
    END IF;

    -- Validate options array
    IF array_length(_options, 1) < 2 THEN
        RAISE EXCEPTION 'At least 2 options are required' USING ERRCODE = 'check_violation';
    END IF;

    IF array_length(_options, 1) > 6 THEN
        RAISE EXCEPTION 'Maximum 6 options allowed' USING ERRCODE = 'check_violation';
    END IF;

    -- Check duplicate options
    IF (SELECT count(DISTINCT lower(trim(opt))) FROM unnest(_options) opt)
       <> array_length(_options, 1) THEN
        RAISE EXCEPTION 'Duplicate option labels are not allowed' USING ERRCODE = 'check_violation';
    END IF;

    -- Insert poll
    INSERT INTO public.polls (
        creator_wallet, question, description, mode,
        destination_wallet, destination_purpose,
        min_nim_luna, fairness_mode,
        status, starts_at, ends_at,
        is_public, published_at,
        created_at, updated_at
    ) VALUES (
        _creator_wallet, trim(_question),
        CASE WHEN _description IS NOT NULL AND length(trim(_description)) > 0
             THEN trim(_description) ELSE NULL END,
        _mode,
        _destination_wallet, trim(_destination_purpose),
        _min_nim_luna, _fairness_mode,
        'live', _now, _ends_at,
        true, _now,
        _now, _now
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
        (creator_wallet, idempotency_key, poll_id)
    VALUES (_creator_wallet, _idempotency_key, _poll_id);

    RETURN jsonb_build_object(
        'id', _poll_id,
        'status', 'live',
        'replay', false
    );
END;
$$;

-- ============================================================================
-- Grants — service_role only; no public write access
-- ============================================================================

GRANT USAGE ON SCHEMA public TO service_role;

-- The atomic publish function inserts into polls, poll_options, and
-- poll_publication_requests, so service_role needs INSERT on those tables.
-- Also grant SELECT + UPDATE on polls for future creator management APIs.
GRANT INSERT ON public.polls TO service_role;
GRANT INSERT ON public.poll_options TO service_role;
GRANT SELECT, INSERT ON public.poll_publication_requests TO service_role;
GRANT SELECT, UPDATE ON public.polls TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_poll_atomic TO service_role;

REVOKE EXECUTE ON FUNCTION public.publish_poll_atomic FROM PUBLIC, anon, authenticated;
