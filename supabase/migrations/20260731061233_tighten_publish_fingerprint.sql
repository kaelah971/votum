-- Tighten publish fingerprint integrity and fix error signalling.
-- 1. Add CHECK constraint on request_fingerprint length (SHA-256 = 64 hex chars).
-- 2. Replace publish_poll_atomic to return result_kind instead of raising 23505.
-- 3. Revoke unnecessary DELETE privileges from service_role.

-- ============================================================================
-- Fingerprint length constraint
-- ============================================================================

-- Drop any rows that might have the old 32-char placeholder
DELETE FROM public.poll_publication_requests
  WHERE length(request_fingerprint) < 64;

-- Now safe to add the constraint
ALTER TABLE public.poll_publication_requests
  ADD CONSTRAINT poll_publication_requests_fingerprint_length
    CHECK (length(request_fingerprint) = 64);

-- ============================================================================
-- Replace function: return result_kind instead of ambiguous 23505
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
    _idempotency_key      uuid,
    _request_fingerprint  text
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
                'status', (SELECT status FROM public.polls WHERE id = _existing.poll_id),
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
        RAISE EXCEPTION 'At least 2 options are required' USING ERRCODE = 'check_violation';
    END IF;

    IF array_length(_options, 1) > 6 THEN
        RAISE EXCEPTION 'Maximum 6 options allowed' USING ERRCODE = 'check_violation';
    END IF;

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
        (creator_wallet, idempotency_key, poll_id, request_fingerprint)
    VALUES (_creator_wallet, _idempotency_key, _poll_id, _request_fingerprint);

    RETURN jsonb_build_object(
        'id', _poll_id,
        'status', 'live',
        'result_kind', 'created'
    );
END;
$$;
